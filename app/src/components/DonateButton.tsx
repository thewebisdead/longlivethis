import { walletAddress } from '@/lib/config'
import { donateUri, explorerUrl, normalizeAddress } from '@/lib/donation'
import CopyAddress from './CopyAddress'

/**
 * Donation button area — visible alongside the treasury balance.
 *
 * Renders nothing when the wallet address is unset (preview / CI): if the app
 * cannot show where to send money it is better to show nothing than a broken
 * link.
 *
 * The flow: an <a> opens the EIP-681 deep-link (handled by MetaMask / Coinbase
 * Wallet / WalletConnect on supported browsers), which pre-fills a 1 USDC
 * transfer to the treasury. Below it is the raw address to copy, plus a link
 * to the block explorer for visitors on devices without a wallet extension.
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

  const uri = donateUri(walletAddress)
  const explorer = explorerUrl(walletAddress)
  // Truncated for display: 0x1234…abcd
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 justify-center">
      <a
        href={uri}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 border border-fg px-3 py-1.5 text-[0.8rem] font-semibold text-fg no-underline hover:bg-fg hover:text-bg"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4" aria-hidden="true">
          <path d="M12 2v20M17 7l-5-5-5 5M7 17l5 5 5-5" />
        </svg>
        Donate 1 USDC
      </a>
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
  )
}
