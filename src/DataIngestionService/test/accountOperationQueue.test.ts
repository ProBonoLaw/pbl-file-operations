import { describe, expect, it } from "vitest";
import { AccountOperationQueue } from "../src/accountOperationQueue.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("AccountOperationQueue", () => {
  it("waits for the previous account operation and releases the queue after failure", async () => {
    const queue = new AccountOperationQueue();
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const order: string[] = [];

    const first = queue.run("account-1", async () => {
      order.push("first started");
      firstStarted.resolve();
      await releaseFirst.promise;
      order.push("first failed");
      throw new Error("ingestion failed");
    });
    const firstAssertion = expect(first).rejects.toThrow("ingestion failed");
    await firstStarted.promise;
    const second = queue.run("account-1", async () => {
      order.push("second started");
      return "removed";
    });

    expect(order).toEqual(["first started"]);
    releaseFirst.resolve();
    await firstAssertion;
    await expect(second).resolves.toBe("removed");
    expect(order).toEqual(["first started", "first failed", "second started"]);
  });

  it("allows different accounts to progress independently", async () => {
    const queue = new AccountOperationQueue();
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const first = queue.run("account-1", async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
      return "first complete";
    });

    await firstStarted.promise;
    try {
      await expect(queue.run("account-2", async () => "second complete"))
        .resolves.toBe("second complete");
    } finally {
      releaseFirst.resolve();
    }
    await expect(first).resolves.toBe("first complete");
  });
});
