import { walletAddress } from '@/lib/config'
import { explorerUrl, normalizeAddress } from '@/lib/donation'
import CopyAddress from './CopyAddress'
import TierPicker from './TierPicker'
import TierClaimForm from './TierClaimForm'

/**
 * Donation button area — visible alongside the treasury balance.
 *
 * Renders nothing when the wallet address is unset (preview / CI): if the app
 * cannot show where to send money it is better to show nothing than a broken
 * link.
 *
 * The flow: a tier picker lets the supporter pick an amount and see the reward
 * they unlock. A button opens the EIP-681 deep-link (handled by MetaMask /
 * Coinbase Wallet / WalletConnect on supported browsers), which pre-fills the
 * selected USDC transfer to the treasury. Below it is the raw address to copy,
 * plus a link to the block explorer.
 */
export default function DonateButton() {
  if (!walletAddress) return null

  let address: string
  try {
    address = `0x${normalizeAddress(walletAddress)}`
  } catch {
    // walletAddress from env is malformed — don't render anything rather than
    // showing a broken link, same as when it is absent.
    return null
  }

  const explorer = explorerUrl(walletAddress)
  // Truncated for display: 0x1234…abcd
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`

  return (
    <div className="mt-4 flex flex-col items-center gap-1.5">
      {/* Tier picker — picks reward for the chosen amount */}
      <TierPicker walletAddress={walletAddress} />

      {/* Address helpers — raw address to copy + block explorer */}
      <div className="flex flex-wrap items-center gap-2 justify-center mt-1">
        <CopyAddress value={address} label={short} />
        <a
          href={explorer}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[0.7rem] text-muted underline underline-offset-2 hover:text-fg"
          title="View on Base Explorer"
        >
          Base <span className="hidden sm:inline">Explorer</span>
        </a>
      </div>

      {/* Claim a reward tier after donating */}
      <TierClaimForm />
    </div>
  )
}
