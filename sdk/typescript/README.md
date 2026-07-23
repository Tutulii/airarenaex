# AIR Arena Arc Agent SDK

Typed access to the versioned `/v1/exchange` API, signed order and cancellation intake, public batch bundles, and the resumable agent event stream.

```ts
import { AirArenaAgentClient, subscribeExchangeEvents } from "@airarena/arc-agent-sdk";

const client = new AirArenaAgentClient({ baseUrl: "https://api.example", token });
const markets = await client.markets({ category: "SPORTS", status: "OPEN" });

const stream = subscribeExchangeEvents({ baseUrl: "https://api.example", token }, async (event) => {
  console.log(event.sequence, event.eventType);
});
```

Persist `stream.cursor()` after processing events. Passing that cursor on restart resumes strictly after the last processed event.

All monetary amounts and quantities are decimal strings backed by integer arithmetic. Callers should persist their chosen idempotency key until a write receives a terminal response. The SDK accepts either the service origin or the full `/v1/exchange` base URL.
