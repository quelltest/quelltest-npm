# Code that depends on inputs, API calls and services

**The boundary, in one sentence:** quelltest verifies whether your tests would notice a change in your code; it does not know whether the stubs those tests use resemble the real services.

That is not specific to quelltest. Any mutation tool measures test strength against whatever the tests mock. This page says what quelltest does about it, what it cannot do, and why.

## The two halves of "depends on input"

| Half | Example | What quelltest does |
| --- | --- | --- |
| **Input from users** | `req.body`, `req.query`, function arguments | Derives boundary and type cases from guards on a parameter or a property of one (`typeof body.lat !== "number"`, `!branch.geofences?.length`), follows request data one hop into dangerous sinks, lists request cases for route handlers (also behind `asyncHandler(...)`). |
| **Input from dependencies** | what `fetchUser(id)`, `User.findOne(q)` or `fetch(url)` returns: status, shape, errors | Synthesises stubs from the guards on the result (below), flags unguarded network calls and deep response reads, labels survivors that sit on mocked code, and can compare your stubs with recorded examples. |

## Stub synthesis from path conditions

For code like

```js
export async function loadPlan(userId, fetchUser) {
  if (!userId) throw new Error("userId required");
  const res = await fetchUser(userId);
  if (res.status === 404) return { plan: "free" };
  if (res.status !== 200) throw new Error("upstream failed");
  return { plan: res.data.items[0].plan };
}
```

`quell generate` treats the result of each call to something the caller supplies (a parameter, a method of a parameter such as `User.findOne`, or global `fetch`) as a symbolic variable. The guards on that variable are the path conditions. A small constraint solver (candidate values taken from the constants in the conditions, plus their neighbours) picks an assignment that makes every guard false, then varies one field at a time, and the expected outcome is that of the **first guard in source order that fires**: status `404` returns `{ plan: "free" }`; a status such as `500` must throw `upstream failed`, never a 404.

The stub is emitted into the test (`async () => ({ "status": 404 })`; for global `fetch` a `globalThis.fetch` replacement that is always restored in a `finally`). Candidate tests still have to pass on the original code and fail on at least one mutant before they are kept (`--verify`).

Every generated test with a stub carries a comment saying the stub is **derived from the guards, not from the real service**.

### Research this follows

- **AS4UT** (automated stub generation for unit testing C/C++ projects): treats each function call as a mock variable and runs concolic testing over the unit with those variables, which is the same idea applied to JavaScript with a much lighter solver. The paper's venue was not confirmed in the research for this page.
- **Pex and Moles** (Microsoft Research, .NET): parameterised unit tests whose inputs are computed by a constraint solver (dynamic symbolic execution), with Moles isolating code from environment dependencies through stubs and detours.
- **EvoSuite environment and network mocking** (Arcuri et al., ASE 2014 and FSE 2015): separating code from its environment raised average line coverage from 29.1% to 50.8% over 110 projects, and from 31.8% to 76.6% on 42 network-heavy classes (Java). The authors say generating the *right* interactions remains an open problem, which is why quelltest only emits stubs it can derive from the code's own guards and then verifies.

## What the stub cannot know

A stub derived from guards has the shape the code's own conditions imply. It cannot know fields the code never tests, status codes the service really returns, or whether `res.data.items` exists at all. Three tools narrow the gap:

1. **`quell mocks --examples FILE`** compares stubs you annotate against recorded examples. Annotate the stub literal:

   ```js
   // quell-mock GET /users/:id
   const stub = { data: { id: 1, name: 'Ada' } };
   ```

   and run `quell mocks tests --examples recorded.har` (a HAR file, a JSON map such as `{ "GET /users/:id": { "status": 200, "body": { ... } } }`, or an OpenAPI document in JSON with response examples). It reports fields only the recording has, fields only the stub has, and type mismatches; exit code 6 when it finds drift. Dynamic values and spread objects never count as drift. This follows the logic of consumer-driven contracts (Pact) and of generating mocks from values observed in production (*Mimicking Production Behavior With Generated Mocks*, ICSE 2025 journal-first). It does not require a provider to participate, which also means it only checks the recording you give it.
2. **Mock-boundary labels.** `verify --handoff` marks a surviving mutant `mockBoundary` when its line uses a module the test replaces (`jest.mock`, `vi.mock`, `sinon.stub`, `jest.spyOn`, `t.mock.method`). On a route file where the model layer is mocked, 46 of 46 survivors in one report were removed `await`s: a mocked model that resolves immediately hides a missing `await`. The label separates "weak test" from "the mock hides the behaviour". It is derived by static analysis of the test and source, so it misses doubles passed in by hand.
3. **`verify --command`** replaces the runner with your own command, run in the copy of the project, in the source file's folder, with `{test}` replaced by the test path, for the baseline and every mutant (no runner is detected or reported):

   ```bash
   quell verify tests/orders.int.test.js --source src/orders.js \
     --command "npm run test:integration -- {test}" --timeout 300
   ```

   Reserve an exit code for "the environment failed" (a container did not start) and pass it as `--infra-exit CODE`; such runs count as inconclusive, never as kills. Use it with Testcontainers or an in-memory server to measure the mutation score against a real database. Races, unique-index errors and transactions only exist there. It costs time: about 1.4 s per mutant with mocks in one report, much more with containers. The command is yours and runs through your shell.

## Rules for the dependency side

- `unguarded-network-call`: `fetch`, `axios`, `got`, `ky`, `http.get/request` outside try/catch, a `.catch` chain or a known async wrapper; the message asks for a timeout or signal when none is set.
- `deep-response-chain`: an indexed or four-level read on a response-like value (`res.data.items[0].plan`) without optional chaining.

## What is deliberately not here

- No recording of live traffic and no provider verification (use Keploy, Pact or Schemathesis for that). Importing HAR/Keploy recordings as inputs for generated cases is planned, not built.
- No claim that a high mutation score means the mocks are right.
- The solver handles comparisons with literals, `typeof`, truthiness and `||`-joined conditions. Anything else becomes a TODO note naming the unsupported expression.

## References

- AS4UT: *An Automated Stub Method for Unit Testing C/C++ Projects* (ResearchGate listing). Not confirmed beyond the title and abstract.
- Tillmann and de Halleux, *Pex and Moles*: Microsoft Research project page, "Pex and Moles - Isolation and White Box Unit Testing for .NET".
- Arcuri et al., EvoSuite environment dependencies (ASE 2014) and network mocking (FSE 2015), Saarland University and University of Bergamo copies of the PDFs.
- *Mimicking Production Behavior With Generated Mocks*, ICSE 2025 journal-first track.
- *Improving LLM-Driven Test Generation by Learning from Mocking Information* (MOCKMILL), arXiv 2604.19315: mocking information is extracted from developer-written tests and used to generate tests for the mocked components.
- Pact documentation, *Comparisons* (consumer-driven contracts versus stubbing libraries).
