import type { DefaultAzureCredential } from "@azure/identity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Crawler } from "../src/processors/crawler.ts";

const browserMocks = vi.hoisted(() => ({
  launch: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
}));

vi.mock("playwright", () => ({
  chromium: { launch: browserMocks.launch },
}));

vi.mock("semaphore-async-await", () => ({
  default: {
    default: class {
      acquire = browserMocks.acquire;
      release = browserMocks.release;
    },
  },
}));

vi.mock("@azure/event-hubs", () => ({
  EventHubProducerClient: class {
    close = vi.fn();
  },
}));

function makePage() {
  return {
    goto: vi.fn(),
    title: vi.fn().mockResolvedValue("Page title"),
    evaluate: vi.fn(),
    content: vi.fn().mockResolvedValue("<p>fallback</p>"),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeBrowser(page: ReturnType<typeof makePage>) {
  return {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeCrawler() {
  return new Crawler("example.test", {} as DefaultAzureCredential, "1", "account-1");
}

beforeEach(() => {
  browserMocks.launch.mockReset();
  browserMocks.acquire.mockReset().mockResolvedValue(true);
  browserMocks.release.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("Crawler browser retries", () => {
  it("stops after three navigation failures and closes every browser", async () => {
    const page = makePage();
    const browser = makeBrowser(page);
    page.goto.mockRejectedValue(new Error("navigation failed"));
    browserMocks.launch.mockResolvedValue(browser);

    await expect(makeCrawler().fetchPageWithPlaywright("https://example.test/"))
      .rejects.toThrow("Failed to fetch https://example.test/ after 3 attempts");

    expect(browserMocks.launch).toHaveBeenCalledTimes(3);
    expect(browserMocks.acquire).toHaveBeenCalledTimes(3);
    expect(browserMocks.release).toHaveBeenCalledTimes(3);
    expect(page.goto.mock.calls.map((call) => call[1].waitUntil)).toEqual([
      "networkidle",
      "networkidle",
      "domcontentloaded",
    ]);
    expect(page.close).toHaveBeenCalledTimes(3);
    expect(browser.close).toHaveBeenCalledTimes(3);
  });

  it("stops after three browser launch failures", async () => {
    browserMocks.launch.mockRejectedValue(new Error("browser unavailable"));

    await expect(makeCrawler().fetchPageWithPlaywright("https://example.test/"))
      .rejects.toThrow("Failed to fetch https://example.test/ after 3 attempts");

    expect(browserMocks.launch).toHaveBeenCalledTimes(3);
    expect(browserMocks.release).toHaveBeenCalledTimes(3);
  });

  it("retries a transient navigation failure and returns the later page", async () => {
    const firstPage = makePage();
    const secondPage = makePage();
    const firstBrowser = makeBrowser(firstPage);
    const secondBrowser = makeBrowser(secondPage);
    firstPage.goto.mockRejectedValue(new Error("temporary failure"));
    secondPage.goto.mockResolvedValue({ status: () => 200 });
    secondPage.evaluate
      .mockResolvedValueOnce(["/other-page"])
      .mockResolvedValueOnce("<p>content</p>");
    browserMocks.launch
      .mockResolvedValueOnce(firstBrowser)
      .mockResolvedValueOnce(secondBrowser);

    await expect(makeCrawler().fetchPageWithPlaywright("https://example.test/"))
      .resolves.toEqual({
        html: "<p>content</p>",
        links: ["/other-page"],
        title: "Page title",
      });

    expect(browserMocks.launch).toHaveBeenCalledTimes(2);
    expect(firstPage.close).toHaveBeenCalledOnce();
    expect(firstBrowser.close).toHaveBeenCalledOnce();
    expect(secondPage.close).toHaveBeenCalledOnce();
    expect(secondBrowser.close).toHaveBeenCalledOnce();
  });

  it("returns an empty page for an HTTP error without retrying", async () => {
    const page = makePage();
    const browser = makeBrowser(page);
    page.goto.mockResolvedValue({
      status: () => 404,
      statusText: () => "Not Found",
    });
    browserMocks.launch.mockResolvedValue(browser);

    await expect(makeCrawler().fetchPageWithPlaywright("https://example.test/missing"))
      .resolves.toEqual({ html: "", links: [] });

    expect(browserMocks.launch).toHaveBeenCalledOnce();
    expect(page.close).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("waits for a semaphore permit before launching a browser", async () => {
    let grantPermit!: (value: boolean) => void;
    const permit = new Promise<boolean>((resolve) => {
      grantPermit = resolve;
    });
    browserMocks.acquire.mockReturnValue(permit);
    const page = makePage();
    const browser = makeBrowser(page);
    page.goto.mockResolvedValue({ status: () => 200 });
    page.evaluate.mockResolvedValueOnce([]).mockResolvedValueOnce("<p>content</p>");
    browserMocks.launch.mockResolvedValue(browser);

    const fetch = makeCrawler().fetchPageWithPlaywright("https://example.test/");
    await new Promise((resolve) => setImmediate(resolve));
    expect(browserMocks.launch).not.toHaveBeenCalled();

    grantPermit(true);
    await expect(fetch).resolves.toMatchObject({ html: "<p>content</p>" });
    expect(browserMocks.release).toHaveBeenCalledOnce();
  });
});

describe("Crawler child pages", () => {
  it("includes the final group of child pages before returning", async () => {
    const crawler = makeCrawler();
    vi.spyOn(crawler, "fetchPageWithPlaywright").mockImplementation(async (url) => ({
      html: `<p>${url}</p>`,
      links: url === "https://example.test/" ? ["/one", "/two"] : [],
      title: "Page",
    }));

    const documents = await crawler.crawl("https://example.test/", 2);

    expect(documents.map((document) => document.metadata.source)).toEqual([
      "https://example.test/",
      "https://example.test/one",
      "https://example.test/two",
    ]);
  });

  it("propagates a child page failure to the ingestion request", async () => {
    const crawler = makeCrawler();
    vi.spyOn(crawler, "fetchPageWithPlaywright").mockImplementation(async (url) => {
      if (url === "https://example.test/") {
        return { html: "<p>root</p>", links: ["/unreachable"], title: "Root" };
      }
      throw new Error("Page failed after 3 attempts");
    });

    await expect(crawler.crawl("https://example.test/", 2))
      .rejects.toThrow("Page failed after 3 attempts");
  });

  it("waits for sibling crawls to finish before reporting a child failure", async () => {
    const crawler = makeCrawler();
    let finishSlowPage!: () => void;
    let reportSlowPageStarted!: () => void;
    const slowPage = new Promise<void>((resolve) => { finishSlowPage = resolve; });
    const slowPageStarted = new Promise<void>((resolve) => { reportSlowPageStarted = resolve; });
    vi.spyOn(crawler, "fetchPageWithPlaywright").mockImplementation(async (url) => {
      if (url === "https://example.test/") {
        return { html: "<p>root</p>", links: ["/failed", "/slow"], title: "Root" };
      }
      if (url.endsWith("/failed")) throw new Error("Page failed after 3 attempts");
      reportSlowPageStarted();
      await slowPage;
      return { html: "<p>slow page</p>", links: [], title: "Slow" };
    });

    const crawl = crawler.crawl("https://example.test/", 2);
    const assertion = expect(crawl).rejects.toThrow("Page failed after 3 attempts");
    let settled = false;
    void crawl.then(() => { settled = true; }, () => { settled = true; });

    try {
      await slowPageStarted;
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
    } finally {
      finishSlowPage();
    }
    await assertion;
  });
});
