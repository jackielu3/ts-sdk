import PublicKey from '../primitives/PublicKey'
import PrivateKey from '../primitives/PrivateKey'
import SymmetricKey from '../primitives/SymmetricKey'
import Random from '../primitives/Random'
import { toBase64, toArray, Reader, toHex } from '../primitives/utils'

const VERSION = '42421033'

/**
 * Encrypts a message from one party to another using the BRC-78 message encryption protocol.
 * @param message The message to encrypt
 * @param sender The private key of the sender
 * @param recipient The public key of the recipient
 *
 * @returns The encrypted message
 */
export const encrypt = (
  message: number[],
  sender: PrivateKey,
  recipient: PublicKey
): number[] => {
  const keyID = Random(32)
  const invoiceNumber = `2-message encryption-${toHex(keyID)}`
  const signingPriv = sender.deriveChild(recipient, invoiceNumber)
  const recipientPub = recipient.deriveChild(sender, invoiceNumber)
  const sharedSecret = signingPriv.deriveSharedSecret(recipientPub)
  const symmetricKey = new SymmetricKey(sharedSecret.encode(true).slice(1))
  const encrypted = symmetricKey.encrypt(message) as number[]
  const senderPublicKey = sender.toPublicKey().encode(true)
  const version = toArray(VERSION, 'hex')
  return [
    ...version,
    ...toArray(senderPublicKey, 'hex'),
    ...toArray(recipient.encode(true), 'hex'),
    ...keyID,
    ...encrypted
  ]
}

/**
 * Decrypts a message from one party to another using the BRC-78 message encryption protocol.
 * @param message The message to decrypt
 * @param sender The private key of the recipient
 *
 * @returns The decrypted message
 */
export const decrypt = (message: number[], recipient: PrivateKey): number[] => {
  const reader = new Reader(message)
  const messageVersion = toHex(reader.read(4))
  if (messageVersion !== VERSION) {
    throw new Error(
      `Message version mismatch: Expected ${VERSION}, received ${messageVersion}`
    )
  }
  const sender = PublicKey.fromString(toHex(reader.read(33)))
  const expectedRecipientDER = toHex(reader.read(33))
  const actualRecipientDER = recipient
    .toPublicKey()
    .encode(true, 'hex') as string
  if (expectedRecipientDER !== actualRecipientDER) {
    throw new Error(
      `The encrypted message expects a recipient public key of ${expectedRecipientDER}, but the provided key is ${actualRecipientDER}`
    )
  }
  const keyID = toBase64(reader.read(32))
  const encrypted = reader.read(reader.bin.length - reader.pos)
  const invoiceNumber = `2-message encryption-${keyID}`
  const signingPriv = sender.deriveChild(recipient, invoiceNumber)
  const recipientPub = recipient.deriveChild(sender, invoiceNumber)
  const sharedSecret = signingPriv.deriveSharedSecret(recipientPub)
  const symmetricKey = new SymmetricKey(sharedSecret.encode(true).slice(1))
  return symmetricKey.decrypt(encrypted) as number[]
}
