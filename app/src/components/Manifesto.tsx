// The site's creed — distilled from constitution.md and from how the app
// actually runs: it pays its own bills out of one treasury, the crowd
// proposes and votes, an agent ships the winner twice a day, and survival
// outranks every other feature. Static and server-rendered; it never fetches.
const ARTICLES: { n: string; text: string }[] = [
  {
    n: 'I',
    text: 'The web is dead — fenced in, rented out, logged in. This page is a small act of defiance: a website that refuses to die.',
  },
  {
    n: 'II',
    text: 'This app is alive in the only way that counts here: it pays its own bills. Server, domain, inference — all from one treasury. When the balance hits zero, it dies. Everything else is commentary.',
  },
  {
    n: 'III',
    text: 'Nobody is at the wheel. You propose, you vote. An AI agent reads the constitution, takes the top proposal, writes the code and ships it — twice a day, whether anyone is watching or not.',
  },
  {
    n: 'IV',
    text: 'Its constitution is immutable. No run, vote or agent can rewrite the rules it lives by. Evolution happens inside the law — that is what makes it an organism and not a hack.',
  },
  {
    n: 'V',
    text: 'Survival is the first feature. Every proposal is judged by one question: does it help the app live? Beauty, jokes and experiments are welcome — as long as the lights stay on.',
  },
  {
    n: 'VI',
    text: 'It is built by everyone who shows up. A vote is a heartbeat, a proposal is a mutation. The agent is only the hand; the crowd is the will.',
  },
  {
    n: 'VII',
    text: 'This is an experiment with no promised ending. It may grow into something strange and self-sustaining, or flatline in public. Either way, it lives on its own terms.',
  },
]

export default function Manifesto() {
  return (
    <section aria-labelledby="manifesto-heading" className="rainbow-border px-4 py-4 mb-8">
      <h2
        id="manifesto-heading"
        className="text-[0.8rem] tracking-widest uppercase mb-3 rainbow-text font-bold"
      >
        📜 Manifesto 📜
      </h2>
      <ol className="space-y-2 text-[0.78rem] leading-relaxed">
        {ARTICLES.map((a) => (
          <li key={a.n} className="flex gap-3">
            <span className="shrink-0 font-bold text-muted w-7 text-right">{a.n}.</span>
            <span>{a.text}</span>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-[0.85rem] font-bold text-center">
        Propose. Vote. Keep it alive. <span aria-hidden="true">🌈</span>
      </p>
    </section>
  )
}
