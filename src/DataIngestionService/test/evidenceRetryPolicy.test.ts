import {afterEach,describe,expect,it,vi} from "vitest";
import {evidenceRetryPolicy,evidenceRetryBudget} from "../src/processors/evidence/evidenceRetryPolicy.js";

afterEach(()=>vi.unstubAllEnvs());
describe("page-proportional evidence retries",()=>{
  it.each([[0,4],[1,4],[15,4],[20,4],[21,7],[40,7],[41,10],[100,16],[101,19],[120,19],[121,22]])(
    "%i pages allows %i total attempts",(pageCount,maxAttempts)=>{
      expect(evidenceRetryBudget({pagesPerGroup:20,retriesPerGroup:3},pageCount).maxAttempts).toBe(maxAttempts);
    });
  it("accepts configurable group sizes and retry counts",()=>{
    vi.stubEnv("EVIDENCE_RETRY_PAGE_GROUP_SIZE","25");
    vi.stubEnv("EVIDENCE_RETRIES_PER_PAGE_GROUP","2");
    expect(evidenceRetryBudget(evidenceRetryPolicy(),100).maxAttempts).toBe(9);
  });
  it.each(["0","-1","1.5","no","Infinity"])("rejects invalid retry settings %s",value=>{
    vi.stubEnv("EVIDENCE_RETRY_PAGE_GROUP_SIZE",value);
    expect(()=>evidenceRetryPolicy()).toThrow("positive integer");
  });
  it.each([-1,1.5,Infinity,NaN])("rejects invalid page count %s",pageCount=>{
    expect(()=>evidenceRetryBudget({pagesPerGroup:20,retriesPerGroup:3},pageCount)).toThrow("page count");
  });
});
