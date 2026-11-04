import {QueueServiceClient} from "@azure/storage-queue";
import {afterEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({sendMessage:vi.fn(async()=>undefined),createIfNotExists:vi.fn(async()=>undefined)}));
vi.mock("@azure/storage-queue",()=>({QueueServiceClient:{fromConnectionString:()=>({getQueueClient:()=>mocks})}}));
import {StorageEvidenceTaskTransport} from "../src/processors/evidence/evidenceTaskQueue.js";
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
describe("evidence task notification lifetime",()=>{
  it.each([undefined,"60000","300001"])("bounds wake-up lifetime by redispatch interval %s while retaining poison messages",async value=>{
    vi.stubEnv("EVIDENCE_TASK_REDISPATCH_MS",value);
    const transport=new StorageEvidenceTaskTransport(QueueServiceClient.fromConnectionString("local-test"));
    const id="a".repeat(64);
    await transport.send("gather",id);
    expect(mocks.sendMessage).toHaveBeenLastCalledWith(JSON.stringify({version:1,taskId:id}),
      {messageTimeToLive:Math.ceil(Number(value??900000)/1000)});
    await transport.send("poison",id);
    expect(mocks.sendMessage).toHaveBeenLastCalledWith(JSON.stringify({version:1,taskId:id}),{messageTimeToLive:30*24*60*60});
  });
});
