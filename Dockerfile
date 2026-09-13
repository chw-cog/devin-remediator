FROM denoland/deno:2.9.6

WORKDIR /app
RUN mkdir -p /data && chown deno:deno /app /data
COPY --chown=deno:deno deno.json deno.lock ./
USER deno
RUN deno install --frozen
COPY --chown=deno:deno src ./src
COPY --chown=deno:deno migrations ./migrations
RUN deno check src/index.ts

EXPOSE 8000
ENTRYPOINT ["deno"]
CMD ["run", "--cached-only", "--allow-net", "--allow-read", "--allow-write=/data", "--allow-ffi", "--allow-sys=cpus,networkInterfaces,hostname", "--allow-env=LOG_LEVEL,DEVIN_API_KEY,DEVIN_ORGANIZATION_ID,DEVIN_MAX_SESSION_BUDGET,DEVIN_MAX_CONCURRENT_SESSIONS,DEVIN_MAX_ATTEMPTS,DEVIN_ANALYSIS_MAX_ATTEMPTS,DEVIN_ORCHESTRATOR_INTERVAL_MS,DEVIN_SUBMITTING_TIMEOUT_SECONDS,GITHUB_WEBHOOK_SECRET,GITHUB_APP_ID,GITHUB_APP_INSTALLATION_ID,GITHUB_APP_PRIVATE_KEY,SQLITE_DB_FILEPATH,LIBSQL_JS_DEV", "src/index.ts"]
