import { examples, feePolicy, limits } from "@/lib/bot";

const fees = feePolicy();

export default function DevelopersPage() {
  return (
    <div className="desk-stack">
      <section className="panel">
        <div className="panel-head">
          <h2>Agents</h2>
          <span className="chip">Prototype · not live</span>
        </div>
        <p>
          A local kit for quoting Polygon PoS, chain 137. It does not hold a seed, does not sign, and does not broadcast.
          The fee router in this tree is the zero address, so unsigned transaction bytes stay closed.
        </p>
        <p className="note">Schema blazar.bot.v1 · OpenAPI 1.0.0 · MCP stdio is a local process, not a registry plugin.</p>
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Fees and routes</h2>
        </div>
        <p>
          <span className="chip">0.05% external</span> <span className="chip">0% own factory</span>
        </p>
        <p>
          The wrapper fee is {fees.wrapperFeeLabel}. {fees.ownFactoryFee} Pool fees are separate and already sit inside the quoted output.
          On 10,000 base units the external fee is {fees.exampleOn10000.externalFee} and the Blazar factory fee is {fees.exampleOn10000.blazarFactoryFee}.
        </p>
        <p className="note">
          The chart shows one pool, scored 70% liquidity and 30% age. A quote may use any allowlisted pool. The chart does not choose the route.
        </p>
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Base units</h2>
        </div>
        {examples.map((example) => (
          <div key={example.title}>
            <strong>{example.title}</strong>
            <p className="note">
              {example.tokenIn} → {example.tokenOut}
              <br />
              {example.human} with {example.decimals} decimals is {example.amountIn}
            </p>
          </div>
        ))}
        <p className="warn">POL and WPOL are the same asset after wrapping. Do not quote them against each other.</p>
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Quickstart</h2>
        </div>
        <p>Health is <a href="/api/bot/health">/api/bot/health</a>. The capability card is <a href="/api/bot/discover">/api/bot/discover</a> and <a href="/.well-known/blazar-bot">/.well-known/blazar-bot</a>. The schema is <a href="/openapi/blazar-bot-v1.yaml">/openapi/blazar-bot-v1.yaml</a>.</p>
        <pre className="note">{`cd web
pnpm exec tsx scripts/mcp-stdio.ts`}</pre>
        <pre className="note">{`{
  "mcpServers": {
    "blazarswap": {
      "command": "pnpm",
      "args": ["exec", "tsx", "scripts/mcp-stdio.ts"],
      "cwd": "web"
    }
  }
}`}</pre>
        <p className="note">
          Quotes: at most {limits.quoteSlots} at once, {limits.quoteWorkMs / 1000}s each, body under {limits.quoteBodyBytes} bytes.
          Other bot calls: {limits.botCallsPerMinute} per minute in that process. These caps are not a public edge quota.
          A host still needs a Polygon RPC and, later, a reviewed router address before any unsigned bytes can be offered.
        </p>
      </section>
    </div>
  );
}
