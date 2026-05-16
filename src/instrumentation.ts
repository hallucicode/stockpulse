export async function register() {
  // Only run on the server (not edge runtime)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Wire log persistence FIRST so the fetcher's start-up logs land in the
    // DB and are visible on /logs.
    const [{ setLoggerSink }, { createPersistingSink }] = await Promise.all([
      import("./lib/logger"),
      import("./lib/log-persistence"),
    ]);
    setLoggerSink(createPersistingSink());

    const { startBackgroundFetcher } = await import("./lib/background-fetcher");
    startBackgroundFetcher();
  }
}
