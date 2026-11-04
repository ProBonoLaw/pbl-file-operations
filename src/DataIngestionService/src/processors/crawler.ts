import { EventData, EventHubProducerClient } from "@azure/event-hubs";
import { DefaultAzureCredential } from "@azure/identity";
import { createHash } from "crypto";
import { Document } from 'langchain';
import { isNumber } from "mathjs";
import { chromium, type Browser, type Page, type Response } from 'playwright';
import Semaphore from 'semaphore-async-await';
import TurndownService from 'turndown';

const regexFilename = /\/([^/?#]+)(?:[?#]|$)/;
const maximumFetchAttempts = 3;
const EventHubsFQDN = process.env.EVENTHUBS_FQDN || '';
const EventHubsName = process.env.EVENTHUBS_NAME || '';

export class Crawler {
    constructor(
        protected domain: string,
        protected credential: DefaultAzureCredential,
        protected identifierIndexSrc: string,
        protected accountId: string = 'defaultAccountId') {
        this.turndownService = new TurndownService();
        this.turndownService.addRule('removeScript', {
            filter: 'script',
            replacement: () => ''
        });
        this.turndownService.addRule('removeiframe', {
            filter: 'iframe',
            replacement: () => ''
        });
        this.turndownService.addRule('removeStyle', {
            filter: 'style',
            replacement: () => ''
        });
        this.turndownService.addRule('removeImage', {
            filter: 'img',
            replacement: () => ''
        });
        this.semaphore = new Semaphore.default(5);
        try {
            this.producer = new EventHubProducerClient(EventHubsFQDN, EventHubsName, credential);
        } catch (e) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            console.error(`Failed to create EventHubProducerClient: ${errorMessage}`);
            throw e;
        }
        if (isNumber(identifierIndexSrc)) {
            this.identifierIndex = parseInt(identifierIndexSrc)
        }
        this.identifierIndex++;
        this.documents = new Map<string, Document>();
    }

    private visited = new Set();
    private files = new Map<string, EventData>();
    private identifierIndex: number = 0;
    private turndownService: TurndownService;
    private semaphore: Semaphore.default;
    private producer: EventHubProducerClient;
    private documents: Map<string, Document>;

    async fetchPageWithPlaywright(url: string): Promise<{ html: string, links: string[], title?: string }> {
        for (let attempt = 0; attempt < maximumFetchAttempts; attempt++) {
            let permitAcquired = false;
            let browser: Browser | undefined;
            let page: Page | undefined;
            try {
                permitAcquired = await this.semaphore.acquire();
                if (!permitAcquired) {
                    throw new Error(`Failed to acquire semaphore for ${url}`);
                }
                browser = await chromium.launch();
                page = await browser.newPage();
                const response: Response | null = await page.goto(url, {
                    waitUntil: attempt < 2 ? 'networkidle' : 'domcontentloaded',
                    timeout: 30000
                });

                if (response && response.status() > 299) {
                    console.warn(`Failed to fetch ${url}: ${response.status()} ${response.statusText()}`);
                    return { html: '', links: [] };
                }

                const title = await page.title();

                const links = await page.evaluate((): string[] => {
                    const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
                    console.log(`Main links found: ${!!anchors}`);
                    return anchors
                        .map(a => a.getAttribute('href'))
                        .map(href => href ? href.split('#')[0] : href)
                        .filter((href): href is string =>
                            !!href &&
                            !href.startsWith('javascript:') &&
                            !href.startsWith('tel:') &&
                            !href.startsWith('mailto:') &&
                            !href.startsWith('sms:'));
                });

                const html = await page.evaluate(() => {
                    const mainSection = Array.from(window.document.querySelectorAll<HTMLElement>('main'));
                    return mainSection.map(x => x.innerHTML).join('\n');
                }) || await page.content();

                return { html, links, title };
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.error(`Failed to fetch ${url} (attempt ${attempt + 1}/${maximumFetchAttempts}):`, errorMessage);
                if (attempt === maximumFetchAttempts - 1) {
                    throw new Error(`Failed to fetch ${url} after ${maximumFetchAttempts} attempts`, { cause: error });
                }
            } finally {
                if (page) {
                    try {
                        await page.close();
                    } catch (error) {
                        console.warn(`Failed to close page for ${url}:`, error);
                    }
                }
                if (browser) {
                    try {
                        await browser.close();
                    } catch (error) {
                        console.warn(`Failed to close browser for ${url}:`, error);
                    }
                }
                if (permitAcquired) this.semaphore.release();
            }
        }
        throw new Error(`Failed to fetch ${url} after ${maximumFetchAttempts} attempts`);
    }

    async crawl(url: string, depth = 2): Promise<Document[]> {
        const docs: Array<Document> = [];
        if (depth <= 0 || this.visited.has(url)) 
        {
            if (this.documents.has(url)) {
                const document = this.documents.get(url);
                if (document) {
                    document.metadata.hitCount = (document.metadata.hitCount || 0) + 1;
                }
            }
            return docs;
        }

        console.log(`Crawling: ${url}`);
        this.visited.add(url);

        const filenameMatch = url.match(regexFilename);
        if (filenameMatch &&
            (filenameMatch[1].endsWith('.pdf')
                || filenameMatch[1].endsWith('.docx')
                || filenameMatch[1].endsWith('.jpg')
                || filenameMatch[1].endsWith('.png')
                || filenameMatch[1].endsWith('.jpeg')
                || filenameMatch[1].endsWith('.gif'))) {
            console.log(`Skipping PDF file: ${url}`);
            const eventData: EventData = {
                body: {
                    eventKind: 'WebSiteDataIngestion',
                    type: 'file',
                    url: url,
                    accountId: this.accountId,
                    identifier: this.identifierIndex++,
                    force: false,
                    highRes: false
                }
            }
            this.files.set(url, eventData);
            return docs; // Skip PDF files
        }

        const { html, links, title } = await this.fetchPageWithPlaywright(url);
        if (!html) return [];

        const md = this.turndownService.turndown(html);

        docs.push(new Document({ pageContent: md, metadata: { source: url, title, hitCount: 1 } }));
        const buffer: Array<Promise<Array<Document>>> = [];
        const collectChildDocuments = async () => {
            const results = await Promise.allSettled(buffer);
            buffer.length = 0;
            const failure = results.find(result => result.status === 'rejected');
            if (failure?.status === 'rejected') throw failure.reason;
            for (const result of results) {
                if (result.status === 'fulfilled') docs.push(...result.value);
            }
        };

        for (const href of links) {
            let fullUrl: URL;
            try {
                fullUrl = new URL(href, url);
            } catch {
                console.error(`Invalid link found: ${href} on ${url}`);
                continue;
            }

            if (fullUrl.host !== this.domain || fullUrl.searchParams.size > 0) continue;
            buffer.push(this.crawl(fullUrl.href, depth - 1));
            if (buffer.length >= 4) await collectChildDocuments();
        }

        if (buffer.length > 0) await collectChildDocuments();

        return docs;
    }

    async sendFilesToBeProcessed(): Promise<void> {
        try {
            console.log(`Sending ${this.files.size} files to Event Hub for processing...`);
            if (this.files.size === 0) {
                console.warn('No files to send to Event Hub.');
                return;
            }

            const skipSupplementalDocuments = process.env.SKIP_INDEXING_SUPPLEMENTAL_DOCUMENTS === 'true';
            if (skipSupplementalDocuments) {
                console.log('Skipping supplemental documents as per configuration.');
                return;
            }

            for (const [url, eventData] of this.files.entries()) {
                try {
                    const partitionKey = createHash("sha256")
                        .update(this.accountId).update("\0").update(url)
                        .digest("hex").toUpperCase();
                    await this.producer.sendBatch([eventData], { partitionKey });

                } catch (e) {
                    const errorMessage = e instanceof Error ? e.message : String(e);
                    console.error(`Failed to add event data for ${url}:`, errorMessage);
                }
            }
        } catch (e) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            console.error(`Failed to create batch or send to Event Hub:`, errorMessage);
        } finally {
            await this.producer.close();
        }
    }
}
