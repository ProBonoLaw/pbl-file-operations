import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modeForOwnerBillingCodes, parseEvidenceExtractionMode, resolveEvidenceExtractionMode,
  routeEvidenceExtractionModeForBudget } from "../src/processors/evidence/evidenceExtractionMode.js";
import {withRequestContext} from "../src/requestContext.js";

const mocks = vi.hoisted(()=>({query:vi.fn(),fetchAll:vi.fn(),dispose:vi.fn(),database:vi.fn(),container:vi.fn()}));
vi.mock("@azure/identity",()=>({DefaultAzureCredential:class {}}));
vi.mock("@azure/cosmos",()=>({CosmosClient:class {
  database(name:string) { mocks.database(name);return {container:(name:string)=>{
    mocks.container(name);return {items:{query:(...args:unknown[])=>{mocks.query(...args);return {fetchAll:mocks.fetchAll};}}};
  }}; }
  dispose() {mocks.dispose();}
}}));
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv("COSMOS_ENDPOINT","https://test.documents.azure.com");});
afterEach(()=>vi.unstubAllEnvs());

describe("case owner's evidence extraction policy",()=>{
  it.each([["S1","fast"],["D","fast"],["G1","thorough"],[" s1 ","fast"],["future-code","thorough"]])(
    "maps owner billing code %s to %s",(code,mode)=>expect(modeForOwnerBillingCodes([code])).toBe(mode));
  it("ignores members without billing codes and does not replace the owner with the highest tier",()=>{
    expect(modeForOwnerBillingCodes([undefined,null,"", "S1"])).toBe("fast");
    expect(modeForOwnerBillingCodes([])).toBe("thorough");
    expect(()=>modeForOwnerBillingCodes(["S1","G1"])).toThrow("Conflicting owner");
  });
  it("looks up the matching case membership in the root partition",async()=>{
    mocks.fetchAll.mockResolvedValue({resources:[{billingCode:"S1"}]});
    expect(await resolveEvidenceExtractionMode("case-account")).toBe("fast");
    expect(mocks.query).toHaveBeenCalledWith(expect.objectContaining({
      query:expect.stringContaining("a.accountId = @account"),
      parameters:[{name:"@root",value:"00000000-0000-0000-0000-000000000000"},{name:"@account",value:"case-account"}],
    }),{partitionKey:["00000000-0000-0000-0000-000000000000"]});
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
  it.each(["fast","thorough"] as const)("honors an explicit %s request without a billing lookup",async mode=>{
    expect(await resolveEvidenceExtractionMode("account",mode)).toBe(mode);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("skips cases under a SHARED_RESOURCES record even when there is an owner billing code",async()=>{
    mocks.fetchAll.mockResolvedValueOnce({resources:[{type:"SHARED_RESOURCES"},{billingCode:"G1"}]})
      .mockResolvedValueOnce({resources:[]});
    expect(await resolveEvidenceExtractionMode("shared","auto")).toBe("skip");
  });
  it("preserves automatic exclusion for legacy shared-resource account details",async()=>{
    mocks.fetchAll.mockResolvedValueOnce({resources:[{billingCode:"S1"}]})
      .mockResolvedValueOnce({resources:[{isSharedResource:true}]});
    expect(await resolveEvidenceExtractionMode("shared")).toBe("skip");
  });
  it("propagates Cosmos failures rather than silently selecting a different mode",async()=>{
    mocks.fetchAll.mockRejectedValue(new Error("Cosmos unavailable"));
    await expect(resolveEvidenceExtractionMode("case","auto")).rejects.toThrow("Cosmos unavailable");
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
  it.each(["quick","FAST",false,3,["fast"],{}])("rejects malformed mode %j",mode=>{
    expect(()=>parseEvidenceExtractionMode(mode)).toThrow("evidenceExtractionMode");
  });
});

describe("session budget preflight",()=>{
  const context={accountId:"account",sourceId:"391",jobId:"session-1"};
  const config={version:1,currency:"USD",validUntil:"2099-01-01T00:00:00Z",
    pricingSource:"https://prices.azure.com/api/retail/prices",
    limits:[{accountId:"account",sourceId:"391",budgetId:"policy-1",limitUsd:"200"}],
    prices:[{origin:"https://models.test",deployment:"research",kind:"responses",
      inputUsdPerMillion:"1",outputUsdPerMillion:"4",maxInputTokens:1000,maxOutputTokens:1000}]};
  it("routes a 97-page document to fast before reviews when its estimate exceeds the session balance",async()=>{
    vi.stubEnv("EVIDENCE_COST_BUDGET_CONFIG",JSON.stringify(config));
    vi.stubEnv("EVIDENCE_BUDGET_PREFLIGHT_CONFIG",JSON.stringify({estimatedThoroughUsdPerPage:"2.5",referenceCharactersPerPage:4000}));
    const budget={availableMicros:vi.fn(async()=>200_000_000)};
    expect(await withRequestContext(context,()=>routeEvidenceExtractionModeForBudget("thorough",97,388_000,budget)))
      .toBe("fast");
    expect(budget.availableMicros).toHaveBeenCalledOnce();
  });
  it("keeps a small document thorough and counts dense text as additional page equivalents",async()=>{
    vi.stubEnv("EVIDENCE_COST_BUDGET_CONFIG",JSON.stringify(config));
    vi.stubEnv("EVIDENCE_BUDGET_PREFLIGHT_CONFIG",JSON.stringify({estimatedThoroughUsdPerPage:"2.5",referenceCharactersPerPage:4000}));
    const budget={availableMicros:vi.fn(async()=>20_000_000)};
    expect(await withRequestContext(context,()=>routeEvidenceExtractionModeForBudget("thorough",3,12_000,budget)))
      .toBe("thorough");
    expect(await withRequestContext(context,()=>routeEvidenceExtractionModeForBudget("thorough",3,40_000,budget)))
      .toBe("fast");
  });
  it("allows a deliberate override to keep thorough mode beyond the cap",async()=>{
    vi.stubEnv("EVIDENCE_COST_BUDGET_CONFIG",JSON.stringify(config));
    vi.stubEnv("EVIDENCE_BUDGET_PREFLIGHT_CONFIG",JSON.stringify({estimatedThoroughUsdPerPage:"2.5",referenceCharactersPerPage:4000}));
    const budget={availableMicros:vi.fn(async()=>0)};
    expect(await withRequestContext({...context,evidenceBudgetOverride:true},()=>
      routeEvidenceExtractionModeForBudget("thorough",97,388_000,budget))).toBe("thorough");
    expect(budget.availableMicros).not.toHaveBeenCalled();
  });
});
