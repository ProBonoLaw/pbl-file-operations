import { CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import {currentRequestContext} from "../../requestContext.js";
import {evidenceCostBudget, evidenceBudgetPreflightConfig, selectedEvidenceBudget, usdMicros,
  type EvidenceCostBudget} from "./evidenceCostBudget.js";

export type EvidenceExtractionMode = "fast" | "thorough";
export type EvidenceExtractionModeInput = "auto" | EvidenceExtractionMode;
export type EvidenceExtractionSelection = EvidenceExtractionMode | "skip";

/** Route a large document before its first paid evidence review. The hard cap
 * still applies to fast mode; an explicit request override bypasses both. */
export async function routeEvidenceExtractionModeForBudget(mode:EvidenceExtractionSelection,
  pageCount:number, characterCount:number,budget?:Pick<EvidenceCostBudget,"availableMicros">):Promise<EvidenceExtractionSelection> {
  if(mode!=="thorough")return mode;
  const selected=selectedEvidenceBudget(currentRequestContext());
  const preflight=selected && evidenceBudgetPreflightConfig();
  if(!selected || !preflight)return mode;
  if(!Number.isSafeInteger(pageCount)||pageCount<0||!Number.isSafeInteger(characterCount)||characterCount<0)
    throw new Error("Invalid evidence source size");
  const units=Math.max(pageCount,Math.ceil(characterCount/preflight.referenceCharactersPerPage));
  const estimate=units*usdMicros(preflight.estimatedThoroughUsdPerPage);
  if(!Number.isSafeInteger(estimate))throw new Error("Evidence preflight cost estimate is too large");
  return estimate>await (budget??evidenceCostBudget()).availableMicros(selected)?"fast":mode;
}

export function parseEvidenceExtractionMode(value: unknown): EvidenceExtractionModeInput {
  if (value === undefined || value === null) return "auto";
  if (value !== "auto" && value !== "fast" && value !== "thorough")
    throw new Error("evidenceExtractionMode must be auto, fast, or thorough");
  return value;
}

/** Unknown billing codes preserve the thorough behavior instead of reducing coverage. */
export function modeForOwnerBillingCodes(codes: readonly unknown[]): EvidenceExtractionMode {
  // A membership with a billing code identifies the owner. Members without one
  // do not participate in tier selection; never pick the highest member tier.
  const owners = [...new Set(codes.flatMap(code => typeof code === "string" && code.trim()
    ? [code.trim().toUpperCase()] : []))];
  if (owners.length > 1) throw new Error("Conflicting owner billing codes for the case account");
  return owners[0] === "S1" || owners[0] === "D" ? "fast" : "thorough";
}

export async function resolveEvidenceExtractionMode(accountId: string,
  requested?: EvidenceExtractionModeInput): Promise<EvidenceExtractionSelection> {
  const mode = parseEvidenceExtractionMode(requested);
  if (mode !== "auto") return mode;
  const endpoint = process.env.COSMOS_ENDPOINT;
  if (!endpoint) throw new Error("COSMOS_ENDPOINT is missing");
  const client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
  try {
    const root = "00000000-0000-0000-0000-000000000000";
    const container = client.database(process.env.COSMOS_DATABASE_NAME || process.env.COSMOS_DATABASE || "db_conversation_history")
      .container(process.env.COSMOS_CONTAINER_NAME || "accounts");
    const [memberships, details] = await Promise.all([
      container.items.query({
        query: "SELECT c.type, a.billingCode FROM c JOIN a IN c.casesAccounts WHERE c.accountId = @root AND a.accountId = @account",
        parameters: [{ name: "@root", value: root }, { name: "@account", value: accountId }],
      }, { partitionKey: [root] }).fetchAll(),
      container.items.query("SELECT c.isSharedResource FROM c WHERE c.type = 'ACCOUNT_DETAILS'",
        {partitionKey:[accountId]}).fetchAll(),
    ]);
    if (memberships.resources.some(row=>row.type === "SHARED_RESOURCES")
      || details.resources.some(row=>row.isSharedResource === true)) return "skip";
    return modeForOwnerBillingCodes(memberships.resources.map(row => row.billingCode));
  } finally { client.dispose(); }
}
