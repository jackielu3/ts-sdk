import TransactionInput from "./TransactionInput";
import TransactionOutput from "./TransactionOutput";
import UnlockingScript from "../script/UnlockingScript";
import LockingScript from "../script/LockingScript";
import { Reader, Writer, toHex, toArray } from "../primitives/utils";
import { hash256 } from "../primitives/Hash";
import FeeModel from "./FeeModel";
import SatoshisPerKilobyte from "./fee-models/SatoshisPerKilobyte";
import {
  Broadcaster,
  BroadcastResponse,
  BroadcastFailure,
} from "./Broadcaster";
import MerklePath from "./MerklePath";
import Spend from "../script/Spend";
import ChainTracker from "./ChainTracker";
import { defaultBroadcaster } from "./broadcasters/DefaultBroadcaster";
import { defaultChainTracker } from "./chaintrackers/DefaultChainTracker";
import { ATOMIC_BEEF, BEEF_V1 } from "./Beef";
import P2PKH from "../script/templates/P2PKH";

/**
 * Represents a complete Bitcoin transaction. This class encapsulates all the details
 * required for creating, signing, and processing a Bitcoin transaction, including
 * inputs, outputs, and various transaction-related methods.
 *
 * @class Transaction
 * @property {number} version - The version number of the transaction. Used to specify
 *           which set of rules this transaction follows.
 * @property {TransactionInput[]} inputs - An array of TransactionInput objects, representing
 *           the inputs for the transaction. Each input references a previous transaction's output.
 * @property {TransactionOutput[]} outputs - An array of TransactionOutput objects, representing
 *           the outputs for the transaction. Each output specifies the amount of satoshis to be
 *           transferred and the conditions under which they can be spent.
 * @property {number} lockTime - The lock time of the transaction. If non-zero, it specifies the
 *           earliest time or block height at which the transaction can be added to the block chain.
 * @property {Record<string, any>} metadata - A key-value store for attaching additional data to
 *           the transaction object, not included in the transaction itself. Useful for adding descriptions, internal reference numbers, or other information.
 * @property {MerkleProof} [merklePath] - Optional. A merkle proof demonstrating the transaction's
 *           inclusion in a block. Useful for transaction verification using SPV.
 *
 * @example
 * // Creating a new transaction
 * let tx = new Transaction();
 * tx.addInput(...);
 * tx.addOutput(...);
 * await tx.fee();
 * await tx.sign();
 * await tx.broadcast();
 *
 * @description
 * The Transaction class provides comprehensive
 * functionality to handle various aspects of transaction creation, including
 * adding inputs and outputs, computing fees, signing the transaction, and
 * generating its binary or hexadecimal representation.
 */
export default class Transaction {
  version: number;
  inputs: TransactionInput[];
  outputs: TransactionOutput[];
  lockTime: number;
  metadata: Record<string, any>;
  merklePath?: MerklePath;
  private cachedHash?: number[];

  // Recursive function for adding merkle proofs or input transactions
  private static addPathOrInputs(
    obj: { pathIndex?: number; tx: Transaction },
    transactions: Record<
      string,
      {
        pathIndex?: number;
        tx: Transaction;
      }
    >,
    BUMPs: MerklePath[]
  ): void {
    if (typeof obj.pathIndex === "number") {
      const path = BUMPs[obj.pathIndex];
      if (typeof path !== "object") {
        throw new Error("Invalid merkle path index found in BEEF!");
      }
      obj.tx.merklePath = path;
    } else {
      for (const input of obj.tx.inputs) {
        // Ensure sourceTXID is defined before using it as an index
        if (!input.sourceTXID) {
          throw new Error("Transaction input is missing a sourceTXID.");
        }

        const sourceObj = transactions[input.sourceTXID];

        if (typeof sourceObj !== "object") {
          throw new Error(
            `Reference to unknown TXID in BEEF: ${input.sourceTXID}`
          );
        }

        input.sourceTransaction = sourceObj.tx;
        this.addPathOrInputs(sourceObj, transactions, BUMPs);
      }
    }
  }

  /**
   * Creates a new transaction, linked to its inputs and their associated merkle paths, from a BEEF (BRC-62) structure.
   * Optionally, you can provide a specific TXID to retrieve a particular transaction from the BEEF data.
   * If the TXID is provided but not found in the BEEF data, an error will be thrown.
   * If no TXID is provided, the last transaction in the BEEF data is returned.
   * @param beef A binary representation of transactions in BEEF format.
   * @param txid Optional TXID of the transaction to retrieve from the BEEF data.
   * @returns An anchored transaction, linked to its associated inputs populated with merkle paths.
   */
  static fromBEEF(beef: number[], txid?: string): Transaction {
    const reader = new Reader(beef);
    const { transactions, BUMPs } = Transaction.parseBEEFData(reader);

    // The last transaction in the BEEF data can be used if txid is not provided
    const txids = Object.keys(transactions);
    const lastTXID = txids[txids.length - 1];
    const targetTXID = txid || lastTXID;

    if (!transactions[targetTXID]) {
      throw new Error(
        `Transaction with TXID ${targetTXID} not found in BEEF data.`
      );
    }

    this.addPathOrInputs(transactions[targetTXID], transactions, BUMPs);

    return transactions[targetTXID].tx;
  }

  /**
   * Creates a new transaction from an Atomic BEEF (BRC-95) structure.
   * Extracts the subject transaction and ensures that all transactions within the BEEF data
   * are part of the dependency graph of the subject transaction.
   * Throws errors if the Atomic BEEF data does not strictly adhere to the BRC-95 specification.
   *
   * @param beef A binary representation of an Atomic BEEF structure.
   * @returns The subject transaction, linked to its associated inputs populated with merkle paths.
   */
  static fromAtomicBEEF(beef: number[]): Transaction {
    const reader = new Reader(beef);
    // Read the Atomic BEEF prefix
    const prefix = reader.readUInt32LE();
    if (prefix !== ATOMIC_BEEF) {
      throw new Error(
        `Invalid Atomic BEEF prefix. Expected 0x01010101, received 0x${prefix.toString(16)}.`
      );
    }

    // Read the subject TXID
    const subjectTXIDArray = reader.read(32);
    const subjectTXID = toHex(subjectTXIDArray);

    // The remaining data is the BEEF data
    const beefReader = new Reader(reader.read());
    const { transactions, BUMPs } = Transaction.parseBEEFData(beefReader);

    // Ensure that the subject transaction exists
    if (!transactions[subjectTXID]) {
      throw new Error(
        `Subject transaction with TXID ${subjectTXID} not found in Atomic BEEF data.`
      );
    }

    // Ensure that all transactions are part of the dependency graph of the subject transaction
    const validTxids = new Set<string>();
    // All BUMP level 0 hashes are valid.
    for (const bump of BUMPs) {
      for (const n of bump.path[0]) {
        if (n.hash) {
          validTxids.add(n.hash);
        }
      }
    }
    // To keep track of which transactions were used.
    const unusedTxTxids = new Set<string>();
    for (const txid of Object.keys(transactions)) unusedTxTxids.add(txid);

    const traverseDependencies = (txid: string) => {
      unusedTxTxids.delete(txid);
      if (validTxids.has(txid)) {
        return;
      }
      validTxids.add(txid);
      const tx = transactions[txid].tx;

      for (const input of tx.inputs) {
        const inputTxid = input.sourceTXID;

        // Ensure inputTxid is defined before using it as an index
        if (!inputTxid) {
          throw new Error(
            `Input transaction is missing a TXID in Atomic BEEF data.`
          );
        }

        if (!transactions[inputTxid]) {
          throw new Error(
            `Input transaction with TXID ${inputTxid} is missing in Atomic BEEF data.`
          );
        }
        traverseDependencies(inputTxid);
      }
    };

    traverseDependencies(subjectTXID);

    // Check for any unrelated transactions
    for (const txid of unusedTxTxids) {
      throw new Error(
        `Unrelated transaction with TXID ${txid} found in Atomic BEEF data.`
      );
    }

    this.addPathOrInputs(transactions[subjectTXID], transactions, BUMPs);

    return transactions[subjectTXID].tx;
  }

  /**
   * Parses BEEF data from a Reader and returns the transactions and BUMPs.
   *
   * @param reader The Reader positioned at the start of BEEF data.
   * @returns An object containing the transactions and BUMPs.
   */
  private static parseBEEFData(reader: Reader): {
    transactions: Record<string, { pathIndex?: number; tx: Transaction }>;
    BUMPs: MerklePath[];
  } {
    // Read the version
    const version = reader.readUInt32LE();
    if (version !== BEEF_V1) {
      throw new Error(
        `Invalid BEEF version. Expected ${BEEF_V1}, received ${version}.`
      );
    }

    // Read the BUMPs
    const numberOfBUMPs = reader.readVarIntNum();
    const BUMPs: MerklePath[] = []; // ✅ Explicitly define as an array of MerklePath
    for (let i = 0; i < numberOfBUMPs; i++) {
      BUMPs.push(MerklePath.fromReader(reader));
    }

    // Read all transactions into an object
    // The object has keys of TXIDs and values of objects with transactions and BUMP indexes
    const numberOfTransactions = reader.readVarIntNum();
    const transactions: Record<
      string,
      { pathIndex?: number; tx: Transaction }
    > = {};

    for (let i = 0; i < numberOfTransactions; i++) {
      const tx = Transaction.fromReader(reader);
      const obj: { pathIndex?: number; tx: Transaction } = { tx };
      const txid = tx.id("hex");
      const hasBump = Boolean(reader.readUInt8());
      if (hasBump) {
        obj.pathIndex = reader.readVarIntNum();
      }
      transactions[txid] = obj;
    }

    return { transactions, BUMPs };
  }

  /**
   * Creates a new transaction, linked to its inputs and their associated merkle paths, from a EF (BRC-30) structure.
   * @param ef A binary representation of a transaction in EF format.
   * @returns An extended transaction, linked to its associated inputs by locking script and satoshis amounts only.
   */
  static fromEF(ef: number[]): Transaction {
    const br = new Reader(ef);
    const version = br.readUInt32LE();
    if (toHex(br.read(6)) !== "0000000000ef") {
      throw new Error("Invalid EF marker");
    }
    const inputsLength = br.readVarIntNum();
    const inputs: TransactionInput[] = [];
    for (let i = 0; i < inputsLength; i++) {
      const sourceTXID = toHex(br.readReverse(32));
      const sourceOutputIndex = br.readUInt32LE();
      const scriptLength = br.readVarIntNum();
      const scriptBin = br.read(scriptLength);
      const unlockingScript = UnlockingScript.fromBinary(scriptBin);
      const sequence = br.readUInt32LE();
      const satoshis = br.readUInt64LEBn().toNumber();
      const lockingScriptLength = br.readVarIntNum();
      const lockingScriptBin = br.read(lockingScriptLength);
      const lockingScript = LockingScript.fromBinary(lockingScriptBin);
      const sourceTransaction = new Transaction(undefined, [], [], undefined);
      sourceTransaction.outputs = Array(sourceOutputIndex + 1).fill(null);
      sourceTransaction.outputs[sourceOutputIndex] = {
        satoshis,
        lockingScript,
      };
      inputs.push({
        sourceTransaction,
        sourceTXID,
        sourceOutputIndex,
        unlockingScript,
        sequence,
      });
    }
    const outputsLength = br.readVarIntNum();
    const outputs: TransactionOutput[] = [];
    for (let i = 0; i < outputsLength; i++) {
      const satoshis = br.readUInt64LEBn().toNumber();
      const scriptLength = br.readVarIntNum();
      const scriptBin = br.read(scriptLength);
      const lockingScript = LockingScript.fromBinary(scriptBin);
      outputs.push({
        satoshis,
        lockingScript,
      });
    }
    const lockTime = br.readUInt32LE();
    return new Transaction(version, inputs, outputs, lockTime);
  }

  /**
   * Since the validation of blockchain data is atomically transaction data validation,
   * any application seeking to validate data in output scripts must store the entire transaction as well.
   * Since the transaction data includes the output script data, saving a second copy of potentially
   * large scripts can bloat application storage requirements.
   *
   * This function efficiently parses binary transaction data to determine the offsets and lengths of each script.
   * This supports the efficient retreival of script data from transaction data.
   *
   * @param bin binary transaction data
   * @returns {
   *   inputs: { vin: number, offset: number, length: number }[]
   *   outputs: { vout: number, offset: number, length: number }[]
   * }
   */
  static parseScriptOffsets(bin: number[]): {
    inputs: Array<{ vin: number; offset: number; length: number }>;
    outputs: Array<{ vout: number; offset: number; length: number }>;
  } {
    const br = new Reader(bin);
    const inputs: Array<{ vin: number; offset: number; length: number }> = [];
    const outputs: Array<{ vout: number; offset: number; length: number }> = [];

    br.pos += 4; // version
    const inputsLength = br.readVarIntNum();
    for (let i = 0; i < inputsLength; i++) {
      br.pos += 36; // txid and vout
      const scriptLength = br.readVarIntNum();
      inputs.push({ vin: i, offset: br.pos, length: scriptLength });
      br.pos += scriptLength + 4; // script and sequence
    }
    const outputsLength = br.readVarIntNum();
    for (let i = 0; i < outputsLength; i++) {
      br.pos += 8; // satoshis
      const scriptLength = br.readVarIntNum();
      outputs.push({ vout: i, offset: br.pos, length: scriptLength });
      br.pos += scriptLength;
    }
    return { inputs, outputs };
  }

  static fromReader(br: Reader): Transaction {
    const version = br.readUInt32LE();
    const inputsLength = br.readVarIntNum();
    const inputs: TransactionInput[] = [];
    for (let i = 0; i < inputsLength; i++) {
      const sourceTXID = toHex(br.readReverse(32));
      const sourceOutputIndex = br.readUInt32LE();
      const scriptLength = br.readVarIntNum();
      const scriptBin = br.read(scriptLength);
      const unlockingScript = UnlockingScript.fromBinary(scriptBin);
      const sequence = br.readUInt32LE();
      inputs.push({
        sourceTXID,
        sourceOutputIndex,
        unlockingScript,
        sequence,
      });
    }
    const outputsLength = br.readVarIntNum();
    const outputs: TransactionOutput[] = [];
    for (let i = 0; i < outputsLength; i++) {
      const satoshis = br.readUInt64LEBn().toNumber();
      const scriptLength = br.readVarIntNum();
      const scriptBin = br.read(scriptLength);
      const lockingScript = LockingScript.fromBinary(scriptBin);
      outputs.push({
        satoshis,
        lockingScript,
      });
    }
    const lockTime = br.readUInt32LE();
    return new Transaction(version, inputs, outputs, lockTime);
  }

  /**
   * Creates a Transaction instance from a binary array.
   *
   * @static
   * @param {number[]} bin - The binary array representation of the transaction.
   * @returns {Transaction} - A new Transaction instance.
   */
  static fromBinary(bin: number[]): Transaction {
    const br = new Reader(bin);
    return Transaction.fromReader(br);
  }

  /**
   * Creates a Transaction instance from a hexadecimal string.
   *
   * @static
   * @param {string} hex - The hexadecimal string representation of the transaction.
   * @returns {Transaction} - A new Transaction instance.
   */
  static fromHex(hex: string): Transaction {
    return Transaction.fromBinary(toArray(hex, "hex"));
  }

  /**
   * Creates a Transaction instance from a hexadecimal string encoded EF.
   *
   * @static
   * @param {string} hex - The hexadecimal string representation of the transaction EF.
   * @returns {Transaction} - A new Transaction instance.
   */
  static fromHexEF(hex: string): Transaction {
    return Transaction.fromEF(toArray(hex, "hex"));
  }

  /**
   * Creates a Transaction instance from a hexadecimal string encoded BEEF.
   * Optionally, you can provide a specific TXID to retrieve a particular transaction from the BEEF data.
   * If the TXID is provided but not found in the BEEF data, an error will be thrown.
   * If no TXID is provided, the last transaction in the BEEF data is returned.
   *
   * @static
   * @param {string} hex - The hexadecimal string representation of the transaction BEEF.
   * @param {string} [txid] - Optional TXID of the transaction to retrieve from the BEEF data.
   * @returns {Transaction} - A new Transaction instance.
   */
  static fromHexBEEF(hex: string, txid?: string): Transaction {
    return Transaction.fromBEEF(toArray(hex, "hex"), txid);
  }

  constructor(
    version: number = 1,
    inputs: TransactionInput[] = [],
    outputs: TransactionOutput[] = [],
    lockTime: number = 0,
    metadata: Record<string, any> = {},
    merklePath?: MerklePath
  ) {
    this.version = version;
    this.inputs = inputs;
    this.outputs = outputs;
    this.lockTime = lockTime;
    this.metadata = metadata;
    this.merklePath = merklePath;
  }

  /**
   * Adds a new input to the transaction.
   *
   * @param {TransactionInput} input - The TransactionInput object to add to the transaction.
   * @throws {Error} - If the input does not have a sourceTXID or sourceTransaction defined.
   */
  addInput(input: TransactionInput): void {
    if (
      typeof input.sourceTXID === "undefined" &&
      typeof input.sourceTransaction === "undefined"
    ) {
      throw new Error(
        "A reference to an an input transaction is required. If the input transaction itself cannot be referenced, its TXID must still be provided."
      );
    }
    // If the input sequence number hasn't been set, the expectation is that it is final.
    if (typeof input.sequence === "undefined") {
      input.sequence = 0xffffffff;
    }
    this.cachedHash = undefined;
    this.inputs.push(input);
  }

  /**
   * Adds a new output to the transaction.
   *
   * @param {TransactionOutput} output - The TransactionOutput object to add to the transaction.
   */
  addOutput(output: TransactionOutput): void {
    this.cachedHash = undefined;
    if (!output.change) {
      if (typeof output.satoshis === "undefined") {
        throw new Error(
          "either satoshis must be defined or change must be set to true"
        );
      }
      if (output.satoshis < 0) {
        throw new Error("satoshis must be a positive integer or zero");
      }
    }
    if (!output.lockingScript) throw new Error("lockingScript must be defined");
    this.outputs.push(output);
  }

  /**
   * Adds a new P2PKH output to the transaction.
   *
   * @param {number[] | string} address - The P2PKH address of the output.
   * @param {number} [satoshis] - The number of satoshis to send to the address - if not provided, the output is considered a change output.
   *
   */
  addP2PKHOutput(address: number[] | string, satoshis?: number): void {
    const lockingScript = new P2PKH().lock(address);
    if (typeof satoshis === "undefined") {
      return this.addOutput({ lockingScript, change: true });
    }
    this.addOutput({
      lockingScript,
      satoshis,
    });
  }

  /**
   * Updates the transaction's metadata.
   *
   * @param {Record<string, any>} metadata - The metadata object to merge into the existing metadata.
   */
  updateMetadata(metadata: Record<string, any>): void {
    this.metadata = {
      ...this.metadata,
      ...metadata,
    };
  }

  /**
   * Computes fees prior to signing.
   * If no fee model is provided, uses a SatoshisPerKilobyte fee model that pays 10 sat/kb.
   * If fee is a number, the transaction uses that value as fee.
   *
   * @param modelOrFee - The initialized fee model to use or fixed fee for the transaction
   * @param changeDistribution - Specifies how the change should be distributed
   * amongst the change outputs
   *
   */
  async fee(
    modelOrFee: FeeModel | number = new SatoshisPerKilobyte(10),
    changeDistribution: "equal" | "random" = "equal"
  ): Promise<void> {
    this.cachedHash = undefined;
    if (typeof modelOrFee === "number") {
      const sats = modelOrFee;
      modelOrFee = {
        computeFee: async () => sats,
      };
    }
    const fee = await modelOrFee.computeFee(this);
    const change = this.calculateChange(fee);
    if (change <= 0) {
      this.outputs = this.outputs.filter((output) => !output.change);
      return;
    }
    this.distributeChange(change, changeDistribution);
  }

  private calculateChange(fee: number): number {
    let change = 0;
    for (const input of this.inputs) {
      if (!input.sourceTransaction) {
        throw new Error(
          "Source transactions are required for all inputs during fee computation"
        );
      }
      const output = input.sourceTransaction.outputs?.[input.sourceOutputIndex];
      if (!output || output.satoshis === undefined) {
        throw new Error(
          "Invalid or missing source output in source transaction"
        );
      }
      change += output.satoshis;
    }
    change -= fee;

    for (const out of this.outputs) {
      if (!out.change) {
        if (out.satoshis === undefined) {
          throw new Error("Invalid output: missing satoshis");
        }
        change -= out.satoshis;
      }
    }
    return change;
  }

  private distributeChange(
    change: number,
    changeDistribution: "equal" | "random"
  ): void {
    let distributedChange = 0;
    const changeOutputs = this.outputs.filter((out) => out.change);

    if (changeDistribution === "random") {
      distributedChange = this.distributeRandomChange(change, changeOutputs);
    } else if (changeDistribution === "equal") {
      distributedChange = this.distributeEqualChange(change, changeOutputs);
    }

    if (distributedChange < change) {
      const lastOutput = this.outputs[this.outputs.length - 1];
      if (lastOutput.satoshis === undefined) {
        throw new Error("Invalid last output: missing satoshis");
      }
      lastOutput.satoshis += change - distributedChange;
    }
  }

  private distributeRandomChange(
    change: number,
    changeOutputs: TransactionOutput[]
  ): number {
    let distributedChange = 0;
    let changeToUse = change;
    const benfordNumbers = Array(changeOutputs.length).fill(1);
    changeToUse -= changeOutputs.length;
    distributedChange += changeOutputs.length;
    for (let i = 0; i < changeOutputs.length - 1; i++) {
      const portion = this.benfordNumber(0, changeToUse);
      benfordNumbers[i] += portion;
      distributedChange += portion;
      changeToUse -= portion;
    }
    for (const output of this.outputs) {
      if (output.change) output.satoshis = benfordNumbers.shift();
    }
    return distributedChange;
  }

  private distributeEqualChange(
    change: number,
    changeOutputs: TransactionOutput[]
  ): number {
    let distributedChange = 0;
    const perOutput = Math.floor(change / changeOutputs.length);
    for (const out of changeOutputs) {
      distributedChange += perOutput;
      out.satoshis = perOutput;
    }
    return distributedChange;
  }

  private benfordNumber(min: number, max: number): number {
    const d = Math.floor(Math.random() * 9) + 1;
    return Math.floor(
      min + ((max - min) * Math.log10(1 + 1 / d)) / Math.log10(10)
    );
  }

  /**
   * Utility method that returns the current fee based on inputs and outputs
   *
   * @returns The current transaction fee
   */
  getFee(): number {
    let totalIn = 0;

    for (const input of this.inputs) {
      if (!input.sourceTransaction) {
        throw new Error(
          "Source transactions or sourceSatoshis are required for all inputs to calculate fee"
        );
      }

      const output = input.sourceTransaction.outputs?.[input.sourceOutputIndex];
      if (!output || output.satoshis === undefined) {
        throw new Error(
          "Invalid or missing source output in source transaction"
        );
      }
      totalIn += output.satoshis;
    }

    let totalOut = 0;
    for (const output of this.outputs) {
      if (output.satoshis === undefined) {
        throw new Error("Invalid output: missing satoshis");
      }
      totalOut += output.satoshis;
    }

    return totalIn - totalOut;
  }

  /**
   * Signs a transaction, hydrating all its unlocking scripts based on the provided script templates where they are available.
   */
  async sign(): Promise<void> {
    this.cachedHash = undefined;
    for (const out of this.outputs) {
      if (typeof out.satoshis === "undefined") {
        if (out.change) {
          throw new Error(
            "There are still change outputs with uncomputed amounts. Use the fee() method to compute the change amounts and transaction fees prior to signing."
          );
        } else {
          throw new Error(
            "One or more transaction outputs is missing an amount. Ensure all output amounts are provided before signing."
          );
        }
      }
    }
    const unlockingScripts = await Promise.all(
      this.inputs.map(async (x, i): Promise<UnlockingScript | undefined> => {
        if (typeof this.inputs[i].unlockingScriptTemplate === "object") {
          return await this.inputs[i].unlockingScriptTemplate.sign(this, i);
        } else {
          return await Promise.resolve(undefined);
        }
      })
    );
    for (let i = 0, l = this.inputs.length; i < l; i++) {
      if (typeof this.inputs[i].unlockingScriptTemplate === "object") {
        this.inputs[i].unlockingScript = unlockingScripts[i];
      }
    }
  }

  /**
   * Broadcasts a transaction.
   *
   * @param broadcaster The Broadcaster instance wwhere the transaction will be sent
   * @returns A BroadcastResponse or BroadcastFailure from the Broadcaster
   */
  async broadcast(
    broadcaster: Broadcaster = defaultBroadcaster()
  ): Promise<BroadcastResponse | BroadcastFailure> {
    return await broadcaster.broadcast(this);
  }

  /**
   * Converts the transaction to a binary array format.
   *
   * @returns {number[]} - The binary array representation of the transaction.
   */
  toBinary(): number[] {
    const writer = new Writer();
    writer.writeUInt32LE(this.version);
    writer.writeVarIntNum(this.inputs.length);

    for (const i of this.inputs) {
      if (
        !i.sourceTXID &&
        (!i.sourceTransaction || !i.sourceTransaction.hash)
      ) {
        throw new Error(
          "Invalid input: sourceTXID or sourceTransaction hash is required"
        );
      }

      const sourceTxID = i.sourceTXID
        ? toArray(i.sourceTXID, "hex").reverse()
        : (i.sourceTransaction!.hash() as number[]);

      writer.write(sourceTxID);
      writer.writeUInt32LE(i.sourceOutputIndex);

      if (!i.unlockingScript) {
        throw new Error("Invalid input: unlockingScript is required");
      }
      const scriptBin = i.unlockingScript.toBinary();
      writer.writeVarIntNum(scriptBin.length);
      writer.write(scriptBin);

      if (typeof i.sequence !== "number") {
        throw new Error("Invalid input: sequence is required");
      }
      writer.writeUInt32LE(i.sequence);
    }

    writer.writeVarIntNum(this.outputs.length);
    for (const o of this.outputs) {
      if (typeof o.satoshis !== "number") {
        throw new Error("Invalid output: satoshis is required");
      }
      writer.writeUInt64LE(o.satoshis);

      const scriptBin = o.lockingScript.toBinary();
      writer.writeVarIntNum(scriptBin.length);
      writer.write(scriptBin);
    }

    writer.writeUInt32LE(this.lockTime);
    return writer.toArray();
  }

  toEF(): number[] {
    const writer = new Writer();
    writer.writeUInt32LE(this.version);
    writer.write([0, 0, 0, 0, 0, 0xef]);
    writer.writeVarIntNum(this.inputs.length);

    for (const i of this.inputs) {
      if (!i.sourceTransaction) {
        throw new Error(
          "All inputs must have source transactions when serializing to EF format"
        );
      }

      const sourceTxID = i.sourceTXID
        ? toArray(i.sourceTXID, "hex").reverse()
        : (i.sourceTransaction.hash() as number[]);

      writer.write(sourceTxID);
      writer.writeUInt32LE(i.sourceOutputIndex);

      if (!i.unlockingScript) {
        throw new Error("Invalid input: unlockingScript is required");
      }
      const scriptBin = i.unlockingScript.toBinary();
      writer.writeVarIntNum(scriptBin.length);
      writer.write(scriptBin);

      if (typeof i.sequence !== "number") {
        throw new Error("Invalid input: sequence is required");
      }
      writer.writeUInt32LE(i.sequence);

      const output = i.sourceTransaction.outputs?.[i.sourceOutputIndex];
      if (!output || typeof output.satoshis !== "number") {
        throw new Error("Invalid input: source output satoshis is required");
      }
      writer.writeUInt64LE(output.satoshis);

      const lockingScriptBin = output.lockingScript.toBinary();
      writer.writeVarIntNum(lockingScriptBin.length);
      writer.write(lockingScriptBin);
    }

    writer.writeVarIntNum(this.outputs.length);
    for (const o of this.outputs) {
      if (typeof o.satoshis !== "number") {
        throw new Error("Invalid output: satoshis is required");
      }
      writer.writeUInt64LE(o.satoshis);

      const scriptBin = o.lockingScript.toBinary();
      writer.writeVarIntNum(scriptBin.length);
      writer.write(scriptBin);
    }

    writer.writeUInt32LE(this.lockTime);
    return writer.toArray();
  }

  /**
   * Converts the transaction to a hexadecimal string EF.
   *
   * @returns {string} - The hexadecimal string representation of the transaction EF.
   */
  toHexEF(): string {
    return toHex(this.toEF());
  }

  /**
   * Converts the transaction to a hexadecimal string format.
   *
   * @returns {string} - The hexadecimal string representation of the transaction.
   */
  toHex(): string {
    return toHex(this.toBinary());
  }

  /**
   * Converts the transaction to a hexadecimal string BEEF.
   *
   * @returns {string} - The hexadecimal string representation of the transaction BEEF.
   */
  toHexBEEF(): string {
    return toHex(this.toBEEF());
  }

  /**
   * Converts the transaction to a hexadecimal string Atomic BEEF.
   *
   * @returns {string} - The hexadecimal string representation of the transaction Atomic BEEF.
   */
  toHexAtomicBEEF(): string {
    return toHex(this.toAtomicBEEF());
  }

  /**
   * Calculates the transaction's hash.
   *
   * @param {'hex' | undefined} enc - The encoding to use for the hash. If 'hex', returns a hexadecimal string; otherwise returns a binary array.
   * @returns {string | number[]} - The hash of the transaction in the specified format.
   */
  hash(enc?: "hex"): number[] | string {
    let hash;
    if (this.cachedHash) {
      hash = this.cachedHash;
    } else {
      hash = hash256(this.toBinary());
      this.cachedHash = hash;
    }
    if (enc === "hex") {
      return toHex(hash);
    }
    return hash;
  }

  /**
   * Calculates the transaction's ID in binary array.
   *
   * @returns {number[]} - The ID of the transaction in the binary array format.
   */
  id(): number[];
  /**
   * Calculates the transaction's ID in hexadecimal format.
   *
   * @param {'hex'} enc - The encoding to use for the ID. If 'hex', returns a hexadecimal string.
   * @returns {string} - The ID of the transaction in the hex format.
   */
  id(enc: "hex"): string;
  /**
   * Calculates the transaction's ID.
   *
   * @param {'hex' | undefined} enc - The encoding to use for the ID. If 'hex', returns a hexadecimal string; otherwise returns a binary array.
   * @returns {string | number[]} - The ID of the transaction in the specified format.
   */
  id(enc?: "hex"): number[] | string {
    const id = [...(this.hash() as number[])];
    id.reverse();
    if (enc === "hex") {
      return toHex(id);
    }
    return id;
  }

  /**
   * Verifies the legitimacy of the Bitcoin transaction according to the rules of SPV by ensuring all the input transactions link back to valid block headers, the chain of spends for all inputs are valid, and the sum of inputs is not less than the sum of outputs.
   *
   * @param chainTracker - An instance of ChainTracker, a Bitcoin block header tracker. If the value is set to 'scripts only', headers will not be verified. If not provided then the default chain tracker will be used.
   *
   * @returns Whether the transaction is valid according to the rules of SPV.
   *
   * @example tx.verify(new WhatsOnChain(), new SatoshisPerKilobyte(1))
   */
  async verify(
    chainTracker: ChainTracker | "scripts only" = defaultChainTracker(),
    feeModel?: FeeModel
  ): Promise<boolean> {
    const verifiedTxids = new Set<string>();
    const txQueue: Transaction[] = [this];

    while (txQueue.length > 0) {
      const tx = txQueue.shift();
      if (!tx) continue; // Ensure tx is defined

      const txid = tx.id("hex");
      if (verifiedTxids.has(txid)) {
        continue;
      }

      // If the transaction has a valid merkle path, verification is complete.
      if (typeof tx.merklePath === "object") {
        if (chainTracker === "scripts only") {
          verifiedTxids.add(txid);
          continue;
        } else {
          const proofValid = await tx.merklePath.verify(txid, chainTracker);
          if (proofValid) {
            verifiedTxids.add(txid);
            continue;
          }
        }
      }

      // Verify fee if feeModel is provided
      if (typeof feeModel !== "undefined") {
        const cpTx = Transaction.fromEF(tx.toEF());
        delete cpTx.outputs[0].satoshis;
        cpTx.outputs[0].change = true;
        await cpTx.fee(feeModel);
        if (tx.getFee() < cpTx.getFee()) {
          throw new Error(
            `Verification failed: Transaction ${txid} has insufficient fee and has not been mined.`
          );
        }
      }

      // Verify each input transaction and evaluate the spend events.
      let inputTotal = 0;
      for (let i = 0; i < tx.inputs.length; i++) {
        const input = tx.inputs[i];

        if (!input.sourceTransaction) {
          throw new Error(
            `Verification failed: Input ${i} of transaction ${txid} is missing a source transaction.`
          );
        }

        if (!input.unlockingScript) {
          throw new Error(
            `Verification failed: Input ${i} of transaction ${txid} is missing an unlocking script.`
          );
        }

        const sourceOutput =
          input.sourceTransaction.outputs[input.sourceOutputIndex];
        if (!sourceOutput || typeof sourceOutput.satoshis !== "number") {
          throw new Error(
            `Verification failed: Output at index ${input.sourceOutputIndex} has no defined satoshis.`
          );
        }

        inputTotal += sourceOutput.satoshis;

        const sourceTxid = input.sourceTransaction.id("hex");
        if (!verifiedTxids.has(sourceTxid)) {
          txQueue.push(input.sourceTransaction);
        }

        const otherInputs = tx.inputs.filter((_, idx) => idx !== i);
        input.sourceTXID = input.sourceTXID || sourceTxid;

        const spend = new Spend({
          sourceTXID: input.sourceTXID,
          sourceOutputIndex: input.sourceOutputIndex,
          lockingScript: sourceOutput.lockingScript,
          sourceSatoshis: sourceOutput.satoshis,
          transactionVersion: tx.version,
          otherInputs,
          unlockingScript: input.unlockingScript,
          inputSequence: input.sequence ?? 0xffffffff, // Default sequence if undefined
          inputIndex: i,
          outputs: tx.outputs,
          lockTime: tx.lockTime,
        });

        if (!spend.validate()) {
          return false;
        }
      }

      // Validate total outputs
      let outputTotal = 0;
      for (const out of tx.outputs) {
        if (typeof out.satoshis !== "number") {
          throw new Error(
            "Every output must have a defined amount during transaction verification."
          );
        }
        outputTotal += out.satoshis;
      }

      if (outputTotal > inputTotal) {
        return false;
      }

      verifiedTxids.add(txid);
    }

    return true;
  }

  /**
   * Serializes this transaction, together with its inputs and the respective merkle proofs, into the BEEF (BRC-62) format. This enables efficient verification of its compliance with the rules of SPV.
   *
   * @param allowPartial If true, error will not be thrown if there are any missing sourceTransactions.
   *
   * @returns The serialized BEEF structure
   * @throws Error if there are any missing sourceTransactions unless `allowPartial` is true.
   */
  toBEEF(allowPartial?: boolean): number[] {
    const writer = new Writer();
    writer.writeUInt32LE(BEEF_V1);
    const BUMPs: MerklePath[] = [];
    const txs: Array<{ tx: Transaction; pathIndex?: number }> = [];

    // Recursive function to add paths and input transactions for a TX
    const addPathsAndInputs = (tx: Transaction): void => {
      const obj: { tx: Transaction; pathIndex?: number } = { tx };
      const hasProof = tx.merklePath !== undefined; // Type guard

      if (hasProof && tx.merklePath) {
        let added = false;

        for (let i = 0; i < BUMPs.length; i++) {
          if (BUMPs[i] === tx.merklePath) {
            obj.pathIndex = i;
            added = true;
            break;
          }

          if (BUMPs[i].blockHeight === tx.merklePath.blockHeight) {
            const rootA = BUMPs[i].computeRoot();
            const rootB = tx.merklePath.computeRoot();
            if (rootA === rootB) {
              BUMPs[i].combine(tx.merklePath);
              obj.pathIndex = i;
              added = true;
              break;
            }
          }
        }

        if (!added) {
          obj.pathIndex = BUMPs.length;
          BUMPs.push(tx.merklePath);
        }
      }

      const duplicate = txs.some((x) => x.tx.id("hex") === tx.id("hex"));
      if (!duplicate) {
        txs.unshift(obj);
      }

      if (!hasProof) {
        for (let i = 0; i < tx.inputs.length; i++) {
          const input = tx.inputs[i];
          if (input.sourceTransaction) {
            addPathsAndInputs(input.sourceTransaction);
          } else if (!allowPartial) {
            throw new Error("A required source transaction is missing!");
          }
        }
      }
    };

    addPathsAndInputs(this);

    writer.writeVarIntNum(BUMPs.length);
    for (const b of BUMPs) {
      writer.write(b.toBinary());
    }

    writer.writeVarIntNum(txs.length);
    for (const t of txs) {
      writer.write(t.tx.toBinary());
      if (typeof t.pathIndex === "number") {
        writer.writeUInt8(1);
        writer.writeVarIntNum(t.pathIndex);
      } else {
        writer.writeUInt8(0);
      }
    }

    return writer.toArray();
  }

  /**
   * Serializes this transaction and its inputs into the Atomic BEEF (BRC-95) format.
   * The Atomic BEEF format starts with a 4-byte prefix `0x01010101`, followed by the TXID of the subject transaction,
   * and then the BEEF data containing only the subject transaction and its dependencies.
   * This format ensures that the BEEF structure is atomic and contains no unrelated transactions.
   *
   * @param allowPartial If true, error will not be thrown if there are any missing sourceTransactions.
   *
   * @returns {number[]} - The serialized Atomic BEEF structure.
   * @throws Error if there are any missing sourceTransactions unless `allowPartial` is true.
   */
  toAtomicBEEF(allowPartial?: boolean): number[] {
    const writer = new Writer();
    // Write the Atomic BEEF prefix
    writer.writeUInt32LE(0x01010101);
    // Write the subject TXID (big-endian)
    writer.write(this.id());
    // Append the BEEF data
    const beefData = this.toBEEF(allowPartial);
    writer.write(beefData);
    return writer.toArray();
  }
}
