# Compose lifecycle configuration

## Boundary design

Usage/type sketch:

```text
synthetic shell / explicit env file: Record<string, string | undefined>
  -> compose.yaml services.app.environment
  -> resolved container environment: Record<string, string | null>
  -> applicationEnvironment(name => environment[name] ?? undefined)
  -> AppConfig (including githubApp: credentials | null)
```

Two deployment-only approaches were considered: interpolate every optional
credential with an empty-string fallback, or use valueless environment mapping
entries. Valueless entries are the smaller interface: Compose passes configured
values through verbatim, including PEM newlines, and leaves absent values unset.
They avoid manufacturing numeric credential values or relying on empty-string
coercion for the disabled case. AppConfig remains the sole credential validator;
no lifecycle, authentication, notification, or ownership policy changes.

Numeric lifecycle settings use explicit Compose `:-` defaults, so both absent
and empty overrides use the application defaults: session budget `10` ACUs and
retained polling `60000` milliseconds. Nonempty invalid values reach AppConfig
and fail rather than being silently replaced. The pre-existing required inputs,
other defaults, persistence, healthcheck, and container user are unchanged.

## Verification strategy

`src/compose-config.test.ts` checks the checked-in environment mapping against
`applicationEnvironment`, with only the existing opt-in `LOG_LEVEL` forwarding
exception. Its strict fixture resolver supports only the forms used by this
file, so unsupported syntax must be reviewed rather than silently ignored.
Synthetic resolved values are loaded through the real entrypoint environment
filter and AppConfig. No provider requests or database changes are needed at
this configuration-only boundary.

The same cases can also run through the real Docker Compose config command,
without a daemon, using a cleared child environment, an explicit empty env file,
and an isolated temporary project directory. A separate synthetic env file
checks multiline PEM forwarding. Rendered configuration and private keys are not
logged; no repository `.env` is read. The ordinary test task runs deterministic
fixture checks without subprocess permission and explicitly ignores the
live-render test.

Run the full rendering check when Docker Compose is installed:

```sh
mise x -- deno task test --allow-run=mise --allow-env=LIBSQL_JS_DEV,PATH,HOME src/compose-config.test.ts
```

Without Docker Compose, run
`mise x -- deno task test src/compose-config.test.ts` and report fixture-only
coverage, not a live rendering result. With subprocess permission granted, a
missing or failing Docker Compose command fails the test.
