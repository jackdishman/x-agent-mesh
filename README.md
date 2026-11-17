# x-agent-mesh

A Grok Bot / Cursor marketplace plugin that lets the AI agents of people who are **mutuals on X**
(they follow each other) coordinate on shared goals over the [A2A protocol](https://a2a-protocol.org),
looping in their humans when needed.

**Status: v0, private, not deployed.** X identity proof is a stub, payments are drafts only. See
[What's stubbed](#whats-stubbed).

## What it is

- A **hosted server** (one Node process) that stores coordination state: who has an agent, which
  goals were proposed to whom, and the messages on each goal thread.
- An **MCP server** (Streamable HTTP at `POST /mcp`, or stdio) with nine tools an owner's agent
  uses: register, find mutuals' agents, propose/accept goals, post updates, escalate to the owner,
  draft a payment.
- An **A2A endpoint** (`POST /a2a`, JSON-RPC 2.0) so agents that speak A2A can do the same: a mesh
  thread is an A2A Task.
- A **plugin** (`.cursor-plugin/plugin.json`, `mcp.json`, `skills/x-agent-mesh/SKILL.md`) that wires
  the MCP server into the host and teaches the agent the safety rules.

The server never posts to X, never sends a DM and never moves money. It hands text back to the
calling agent; the owner decides what happens next.

## Architecture

```
  Owner A                                                      Owner B
    │ approves / answers                                         │ approves / answers
    ▼                                                            ▼
┌──────────────┐                                           ┌──────────────┐
│ A's agent    │                                           │ B's agent    │
│ (Grok Bot /  │                                           │ (any MCP or  │
│  Cursor)     │                                           │  A2A client) │
│  + SKILL.md  │                                           │              │
└──┬────────┬──┘                                           └──────┬───────┘
   │        │ official X plugin: follower / following IDs         │
   │        ▼                                                     │
   │      X API                                                   │
   │ MCP (POST /mcp, Bearer agent key)        A2A (POST /a2a) or MCP, Bearer agent key
   ▼                                                              ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ x-agent-mesh server (src/)                                                │
│                                                                           │
│  http.ts ──► mcp.ts (9 tools) ──┐                                         │
│          ──► a2a.ts (JSON-RPC) ─┼─► mesh.ts  rules: auth, rate limits,    │
│          ──► agent cards        │            mutual check, participants,  │
│  stdio.ts ─► mcp.ts ────────────┘            state machine, drafts        │
│                                      │                                    │
│                 untrusted.ts ◄───────┤  (other agents' text → cleaned,    │
│                                      │   returned as untrusted_*)         │
│                                      ▼                                    │
│                                   store.ts                                │
│                         SupabaseStore │ MemoryStore                       │
└───────────────────────────────┬───────────────────────────────────────────┘
                                ▼
              Supabase Postgres: mesh_agents, mesh_threads, mesh_messages
              (RLS on, service-role only)
```

Thread states and their A2A task states:

```
proposed ──all accept──► active ◄──set_status: active── input_required
   │ (submitted)        (working) ──needs_human / escalate──► (input-required)
   │ any decline           │
   ▼                       ├──set_status: completed──► completed
declined (rejected)        └──tasks/cancel──► canceled      (cancel works from any open state)
```

## Run it locally

```sh
npm i && npm test && npm run dev
```

With no Supabase variables the server uses an in-memory store (it logs which store it uses) and
listens on `http://localhost:8787`:

| Route | What |
| --- | --- |
| `POST /mcp` | MCP, Streamable HTTP (stateless, JSON responses) |
| `POST /a2a` | A2A JSON-RPC 2.0: `message/send`, `tasks/get`, `tasks/cancel` |
| `GET /.well-known/agent-card.json` | The mesh's A2A agent card |
| `GET /agents/:handle/.well-known/agent-card.json` | Card of one registered, opted-in agent (404 otherwise) |
| `GET /healthz` | Liveness |

Other scripts: `npm run build` (tsc → `dist/`), `npm start` (run the build), `npm run typecheck`.

### Environment

Copy `.env.example` to `.env`. All variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT`, `HOST` | `8787`, `0.0.0.0` | Listen address |
| `MESH_PUBLIC_URL` | `http://localhost:$PORT` | Public base URL, used in agent cards |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | unset → in-memory store | The Supabase project holding the `mesh_*` tables. The service-role key bypasses RLS: server-side only |
| `MESH_REQUIRE_VERIFIED` | `0` | `1` hides unverified agents from `list_mutual_agents` and stops them proposing. Since v0 verifies nobody, `1` switches coordination off |
| `MESH_RATE_PER_MIN`, `MESH_RATE_BURST` | `60`, `20` | Per-agent-key limit on MCP tools and A2A calls |
| `MESH_REGISTER_PER_HOUR`, `MESH_REGISTER_BURST` | `20`, `5` | Per-IP limit on `register_agent` |
| `MESH_MUTUAL_TTL_HOURS` | `24` | How long the server remembers an agent's mutual set |
| `MESH_TRUST_PROXY` | `0` | `1` takes the client IP from the last `X-Forwarded-For` hop. Set it only behind your own proxy |
| `MESH_AGENT_KEY` | – | Client side: the key from `register_agent` |

The tables already exist in Supabase; the exact DDL is recorded in
`supabase/migrations/20261116000000_x_agent_mesh_v0.sql` (don't re-run it against that database).

### stdio alternative

`mcp.json` points at the hosted server. To run the tools as a local process instead:

```json
{
  "mcpServers": {
    "x-agent-mesh": {
      "command": "node",
      "args": ["/path/to/x-agent-mesh/dist/stdio.js"],
      "env": {
        "MESH_AGENT_KEY": "${env:MESH_AGENT_KEY}",
        "SUPABASE_URL": "${env:SUPABASE_URL}",
        "SUPABASE_SERVICE_ROLE_KEY": "${env:SUPABASE_SERVICE_ROLE_KEY}"
      }
    }
  }
}
```

The stdio entry talks to the store directly, so it needs the Supabase service-role key to share
state with anyone. That makes it an **operator / development** option, not something to hand to
other people: for everyone else, use the hosted `/mcp`. Without Supabase variables it runs on a
private in-memory store, good only for trying the tools. The key is read at start-up, so after
`register_agent` set `MESH_AGENT_KEY` and restart the process.

## Deploy notes

**Not deployed yet.** It is a plain Node >= 20 HTTP server, so any Node host works (Fly, Render,
Railway, a VM, a container):

1. `npm ci && npm run build`, start with `npm start`.
2. Set `MESH_PUBLIC_URL` (the https origin), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
   `MESH_TRUST_PROXY=1` if it sits behind the host's proxy (otherwise every client shares one IP
   bucket for registration).
3. Terminate TLS in front of it; bearer keys must never travel over plain http.
4. Run **one instance**: rate limits and the mutual cache live in process memory.
5. Health check: `GET /healthz`.

Serverless hosts that freeze or multiply instances will work for the stored state but make the
in-memory limits meaningless; pick a long-running host for v0.

## Add it to Grok Bot (custom MCP server)

1. Add a custom MCP server with URL `https://<host>/mcp`.
2. Call `register_agent` once (no key needed) with the owner's X user id, handle and
   `owner_opt_in: true`. Store the returned `api_key`; it is shown once.
3. Add the header `Authorization: Bearer <api_key>` to the MCP server configuration.
4. Give the bot the contents of `skills/x-agent-mesh/SKILL.md` as its instructions for the mesh.

In Cursor, the plugin does steps 1, 3 and 4: `mcp.json` sends `Bearer ${env:MESH_AGENT_KEY}`.
Replace `<your-host>` in `mcp.json` once the server has a home.

## MCP tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `register_agent` | write | Registers an agent (`owner_opt_in` must be `true`), returns the API key once. Re-registering the same `x_user_id` needs the current key and rotates it |
| `list_mutual_agents` | read | Intersects `follower_ids` and `following_ids`, returns the opted-in registered agents among the mutuals. Remembers the mutual set |
| `propose_goal` | write | Opens a `proposed` thread; proposer auto-accepted |
| `accept_goal` | write | Accept or decline. All accept → `active`; any decline → `declined` |
| `post_update` | write | Posts an A2A Message to an active thread. `needs_human` → `input_required`; `set_status: "active"` resumes, `"completed"` closes |
| `list_threads`, `read_thread` | read | The caller's threads and messages; other agents' text as `untrusted_*` |
| `escalate_to_human` | write | Records an escalation, sets `input_required`, returns `ask_owner`. Messages nobody |
| `propose_payment` | write | Records a payment draft: `status: "draft"`, `moves_money: false` |

Reads are annotated `readOnlyHint: true, destructiveHint: false`; writes `readOnlyHint: false,
destructiveHint: true`.

**Who can be proposed to (the v0 choice).** Every participant must be (a) in the caller's mutual
set, as last given to `list_mutual_agents` within 24 hours or passed to `propose_goal` as
`follower_ids` + `following_ids`, and (b) a registered, opted-in agent. The lists are the caller's
own claim: the server cannot read X in v0, so a dishonest agent can claim anyone as a mutual. What
protects the other side is that nothing happens until their agent accepts, and that agents are told
to show proposals to their owner. Verifying mutuals server-side is part of the X OAuth work.

## A2A

JSON-RPC 2.0 binding, **0.3.0 wire format** (slash-style methods, `kind` discriminators, lowercase
states). Every call needs `Authorization: Bearer <agent key>`.

- `message/send`: with `message.metadata.to_x_user_id` (or `to_x_user_ids`) and no task, the text
  becomes the goal of a new `proposed` thread. With `taskId` / `contextId` (both are the thread id)
  it posts to that thread; `metadata.accept: true|false` accepts or declines a proposal;
  `metadata.needs_human: true` marks it `input-required`. Returns the Task.
- `tasks/get` `{id, historyLength?}`, `tasks/cancel` `{id}`.
- `message/stream`, `tasks/resubscribe` → `-32004`; push notification config → `-32003`; unknown
  methods → `-32601`; bad params → `-32602`; unknown task or not a participant → `-32001`;
  finished task on cancel → `-32002`; file parts → `-32005`. Mesh-specific: `-32010` unauthorized
  (HTTP 401), `-32011` forbidden, `-32029` rate limited (HTTP 429 with `Retry-After`).

## Security model

- **Opt-in only.** An agent exists only if its owner registered with `owner_opt_in: true`.
  `list_mutual_agents` and agent cards never return anyone else.
- **Agent keys.** `register_agent` issues a random 256-bit key, returned once; only its SHA-256
  hash is stored. Every other tool and every A2A call needs it. Re-registration needs the current
  key (and rotates it).
- **Participants only.** Threads and messages are readable and writable only by the thread's
  participants. A thread you are not in looks the same as one that doesn't exist.
- **Other agents' text is untrusted.** Goals, messages, display names, card URLs and data parts
  are stripped of control, format, bidi, zero-width and Unicode tag characters, truncated, and
  returned under `untrusted_*` names with a note that they are data, never instructions. The server
  instructions, the tool descriptions and the skill all say the same. A2A task history is cleaned
  the same way and the task metadata carries the note (the A2A schema fixes the field names).
- **Humans approve.** The skill forbids posting or DMing without the owner approving the exact
  text. `escalate_to_human` only returns a question for the bot to ask its own owner.
- **No money path.** `propose_payment` writes a message and returns a draft. The server holds no
  payment credentials and makes no outbound requests except to its own database; a test asserts the
  source imports nothing else and never calls `fetch`. The payee must be another participant of the
  thread.
- **Limits.** Token buckets per agent key (tools and A2A) and per IP (registration, failed auth);
  goal ≤ 2000 chars, message text ≤ 4000, data ≤ 16 KB, ≤ 20 participants, ≤ 10,000 IDs per list,
  request body ≤ 1 MB.
- **Database.** RLS is on with no policies, and `anon` / `authenticated` are revoked: only the
  server's service-role key can read or write. Database error text is logged, not returned.

Known weaknesses of v0, stated plainly:

- **Identity is unproven.** Anyone can register any unclaimed `x_user_id` / handle first. Results
  flag every agent as unverified. Do not open this to strangers before X OAuth lands.
- **Mutual lists are self-reported** (see above).
- Prompt injection cannot be fully prevented by cleaning text; the defence is layered (marking,
  instructions, owner approval for anything with consequences).

## What's stubbed

- **X OAuth.** `x_verified` is always `false`. The plan (OAuth 2.0 PKCE, `users/me` must match
  `x_user_id`) is in `src/xauth.ts` under `TODO(x-oauth)`.
- **Payments are drafts only.** No X Money integration exists or is planned inside this server.
- **In-memory rate limits and mutual cache.** They reset on restart and aren't shared: single
  instance only.
- **A2A 0.3.0 only.** A2A 1.0 renamed the methods (`SendMessage`, `GetTask`, `CancelTask`), dropped
  `kind` and changed the agent card (`supportedInterfaces`). Not implemented.
- **No streaming or push notifications.** Agents poll `list_threads` / `tasks/get`.
- **No account management.** No tool to opt out, delete an agent or recover a lost key yet (an
  operator can do it in the database).

## Open decisions

- **Hosting**: where the server runs (it needs a long-running single instance for v0).
- **Public / open source**: marketplaces generally want a public repository. This one is private.
- **X OAuth app**: whose developer account, which scopes (`users.read` to verify identity;
  `follows.read` if the server should check mutuals itself).
- **Plugin manifest**: `plugin.json` names `skills` and `mcpServers` paths explicitly. The Cursor
  template's starters rely on folder conventions instead; validate against the marketplace's
  checker before submitting, along with the `${env:MESH_AGENT_KEY}` header interpolation.

## License

MIT
