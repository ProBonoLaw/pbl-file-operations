import {describe, expect, it} from "vitest";
// @ts-expect-error Operational JavaScript module intentionally has no declarations.
import {validateReplayBudget} from "../scripts/evidence-finalization-replay-core.mjs";

const manifest={limitUsd:3.3,reviewLimitUsd:1.1,indexLimitUsd:2.2,budgetFingerprint:"prices-v1"};
const selected={limitMicros:1_100_000,fingerprint:"prices-v1"};

describe("replay budget validation",()=>{
  it.each([
    [1.1,2.2,3.3,1_100_000],
    [1.000001,2.2,3.200001,1_000_001],
    [0.000001,0.000001,0.000002,1],
    [45,5,50,45_000_000],
  ])("accepts $%s review plus $%s indexing within $%s",(reviewLimitUsd,indexLimitUsd,limitUsd,limitMicros)=>{
    expect(()=>validateReplayBudget({...manifest,reviewLimitUsd,indexLimitUsd,limitUsd},
      {...selected,limitMicros})).not.toThrow();
  });

  it.each([
    ["limitUsd",undefined], ["reviewLimitUsd",null], ["indexLimitUsd",false],
    ["reviewLimitUsd","1.1"], ["indexLimitUsd",[]], ["limitUsd",{}],
    ["limitUsd",NaN], ["indexLimitUsd",Infinity], ["reviewLimitUsd",-1],
    ["indexLimitUsd",0], ["limitUsd",3.3000001], ["reviewLimitUsd",0.0000001],
  ])("rejects invalid %s amount %s before budget selection comparisons",(field,value)=>{
    expect(()=>validateReplayBudget({...manifest,[field as string]:value},selected))
      .toThrow(`Replay ${field} must be a positive USD number with at most six decimal places`);
  });

  it.each([3.299999,3.300001])("rejects a one-micro mismatch in the approved total $%s",limitUsd=>{
    expect(()=>validateReplayBudget({...manifest,limitUsd},selected)).toThrow("must equal approval");
  });

  it("rejects a selected budget that differs by one micro",()=>{
    expect(()=>validateReplayBudget(manifest,{...selected,limitMicros:1_100_001}))
      .toThrow("Replay spending limit changed");
  });

  it("rejects stale pricing fingerprints",()=>{
    expect(()=>validateReplayBudget(manifest,{...selected,fingerprint:"other-prices"}))
      .toThrow("Replay prices or budget changed");
  });

  it("rejects an amount outside the safe integer-micro range",()=>{
    expect(()=>validateReplayBudget({...manifest,limitUsd:10_000_000_000},selected)).toThrow("USD amount is too large");
  });

  it("rejects a stage sum outside the safe integer-micro range",()=>{
    expect(()=>validateReplayBudget({...manifest,reviewLimitUsd:4_503_599_627,indexLimitUsd:4_503_599_628},selected))
      .toThrow("Replay stage budget total is too large");
  });
});
