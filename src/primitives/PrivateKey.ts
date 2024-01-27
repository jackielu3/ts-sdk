import BigNumber from './BigNumber.js'
import Signature from './Signature.js'
import PublicKey from './PublicKey.js'
import Point from './Point.js'
import Curve from './Curve.js'
import { sign, verify } from './ECDSA.js'
import { sha256, sha256hmac } from './Hash.js'
import Random from './Random.js'
import { toArray, toBase58Check } from './utils.js'

/**
 * Represents a Private Key, which is a secret that can be used to generate signatures in a cryptographic system.
 *
 * The `PrivateKey` class extends from the `BigNumber` class. It offers methods to create signatures, verify them,
 * create a corresponding public key and derive a shared secret from a public key.
 *
 * @extends {BigNumber}
 * @see {@link BigNumber} for more information on BigNumber.
 */
export default class PrivateKey extends BigNumber {
  /**
   * Generates a private key randomly.
   *
   * @method fromRandom
   * @static
   * @returns The newly generated Private Key.
   *
   * @example
   * const privateKey = PrivateKey.fromRandom();
   */
  static fromRandom (): PrivateKey {
    return new PrivateKey(Random(32))
  }

  /**
   * Generates a private key from a string.
   *
   * @method fromString
   * @static
   * @param str - The string to generate the private key from.
   * @param base - The base of the string.
   * @returns The generated Private Key.
   * @throws Will throw an error if the string is not valid.
   **/
  static fromString (str: string, base: number | 'hex'): PrivateKey {
    return new PrivateKey(BigNumber.fromString(str, base).toArray())
  }

  /**
   * Signs a message using the private key.
   *
   * @method sign
   * @param msg - The message (array of numbers or string) to be signed.
   * @param enc - If 'hex' the string will be treated as hex, utf8 otherwise.
   * @param forceLowS - If true (the default), the signature will be forced to have a low S value.
   * @param customK — If provided, uses a custom K-value for the signature. Provie a function that returns a BigNumber, or the BigNumber itself.
   * @returns A digital signature generated from the hash of the message and the private key.
   *
   * @example
   * const privateKey = PrivateKey.fromRandom();
   * const signature = privateKey.sign('Hello, World!');
   */
  sign (msg: number[] | string, enc?: 'hex', forceLowS: boolean = true, customK?: Function | BigNumber): Signature {
    const msgHash = new BigNumber(sha256(msg, enc), 16)
    return sign(msgHash, this, forceLowS, customK)
  }

  /**
   * Verifies a message's signature using the public key associated with this private key.
   *
   * @method verify
   * @param msg - The original message which has been signed.
   * @param sig - The signature to be verified.
   * @param enc - The data encoding method.
   * @returns Whether or not the signature is valid.
   *
   * @example
   * const privateKey = PrivateKey.fromRandom();
   * const signature = privateKey.sign('Hello, World!');
   * const isSignatureValid = privateKey.verify('Hello, World!', signature);
   */
  verify (msg: number[] | string, sig: Signature, enc?: 'hex'): boolean {
    const msgHash = new BigNumber(sha256(msg, enc), 16)
    return verify(msgHash, sig, this.toPublicKey())
  }

  /**
   * Converts the private key to its corresponding public key.
   *
   * The public key is generated by multiplying the base point G of the curve and the private key.
   *
   * @method toPublicKey
   * @returns The generated PublicKey.
   *
   * @example
   * const privateKey = PrivateKey.fromRandom();
   * const publicKey = privateKey.toPublicKey();
   */
  toPublicKey (): PublicKey {
    const c = new Curve()
    const p = c.g.mul(this)
    return new PublicKey(p.x, p.y)
  }

  /**
   * Converts the private key to a Wallet Import Format (WIF) string.
   * 
   * Base58Check encoding is used for encoding the private key.
   * The prefix 
   * 
   * @method toWif
   * @returns The WIF string.
   * 
   * @param prefix defaults to [0x80] for mainnet, set it to [0xef] for testnet.
   * 
   * @example
   * const privateKey = PrivateKey.fromRandom();
   * const wif = privateKey.toWif();
   * const testnetWif = privateKey.toWif([0xef]);
   */
  toWif (prefix : number[] = [0x80]): string {
    return toBase58Check([...this.toArray(), 1], prefix)
  }

  /**
   * Base58Check encodes the hash of the public key associated with this private key with a prefix to indicate locking script type.
   * Defaults to P2PKH for mainnet, otherwise known as a "Bitcoin Address".
   * 
   * @param prefix defaults to [0x00] for mainnet, set to [0x6f] for testnet.
   * 
   * @returns Returns the address encoding associated with the hash of the public key associated with this private key. 
   * 
   * @example
   * const address = pubkey.toAddress()
   * const testnetAddress = pubkey.toAddress([0x6f])
   */
  toAddress (prefix : number[] = [0x00]): string {
    return this.toPublicKey().toAddress(prefix)
  }

  /**
   * Derives a shared secret from the public key.
   *
   * @method deriveSharedSecret
   * @param key - The public key to derive the shared secret from.
   * @returns The derived shared secret (a point on the curve).
   * @throws Will throw an error if the public key is not valid.
   *
   * @example
   * const privateKey = PrivateKey.fromRandom();
   * const publicKey = privateKey.toPublicKey();
   * const sharedSecret = privateKey.deriveSharedSecret(publicKey);
   */
  deriveSharedSecret (key: PublicKey): Point {
    if (!key.validate()) {
      throw new Error('Public key not valid for ECDH secret derivation')
    }
    return key.mul(this)
  }

  /**
   * Derives a child key with BRC-42.
   * @param publicKey The public key of the other party
   * @param invoiceNumber The invoice number used to derive the child key
   * @returns The derived child key.
   */
  deriveChild (publicKey: PublicKey, invoiceNumber: string): PrivateKey {
    const sharedSecret = this.deriveSharedSecret(publicKey)
    const invoiceNumberBin = toArray(invoiceNumber, 'utf8')
    const hmac = sha256hmac(sharedSecret.encode(true), invoiceNumberBin)
    const curve = new Curve()
    return new PrivateKey(this.add(new BigNumber(hmac)).mod(curve.n).toArray())
  }
}
