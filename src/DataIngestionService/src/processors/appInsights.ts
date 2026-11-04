import appInsights from "applicationinsights";

// Ensure we only initialize once (important for Azure Functions cold starts)
if (!appInsights.defaultClient) {
    appInsights.setup()
        .setAutoCollectRequests(true)   // Automatically track HTTP requests
        .setAutoCollectExceptions(true)  // Uncaught exceptions
        .setAutoCollectDependencies(true) // Outbound calls
        .setAutoDependencyCorrelation(true)
        .setSendLiveMetrics(false)       // Optional: enable if needed
        .start();
}

export const telemetryClient = appInsights.defaultClient;
if (telemetryClient) {
    telemetryClient.context.tags[telemetryClient.context.keys.cloudRole] = process.env.ROLE?.startsWith("evidence-")
        ? `file-operations-${process.env.ROLE}` : "file-operations-data-ingestion";
}
