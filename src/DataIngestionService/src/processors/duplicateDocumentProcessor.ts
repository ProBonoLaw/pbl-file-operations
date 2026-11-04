import { CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import { SearchClient, SearchIndexClient } from "@azure/search-documents";
import { searchDocumentClientOptions } from "./searchClientOptions.js";

export class DuplicateDocumentProcessor {
    private defaultCredential!: DefaultAzureCredential;
    private generalIndexClient!: SearchClient<object>;
    private dataSourceId!: string;
    private searchEndpoint!: string;
    constructor(
        private accountId: string,
        private cosmosDbEndpoint: string = process.env.COSMOS_ENDPOINT!,
        private cosmosDbName: string = process.env.COSMOS_DATABASE_NAME || "db_conversation_history",
        private cosmosDbContainerName: string = process.env.COSMOS_CONTAINER_NAME || "accounts") {
    }

    async open() {
        this.defaultCredential = new DefaultAzureCredential();
        if (!this.cosmosDbEndpoint || !this.cosmosDbName || !this.cosmosDbContainerName) {
            throw new Error("Cosmos DB configuration is missing");
        }
        const cosmosDbClient = new CosmosClient({
            endpoint: this.cosmosDbEndpoint,
            aadCredentials: this.defaultCredential
        });
        try {
            const database = cosmosDbClient.database(this.cosmosDbName);
            const container = database.container(this.cosmosDbContainerName);
            const results = await container.items.query({
                query: `SELECT c.dataSourceId, c.searchEndpoint FROM c WHERE c.type = 'ACCOUNT_DETAILS'`
            },
                {
                    partitionKey: [this.accountId]
                }).fetchAll();
            if (results.resources.length === 0) {
                throw new Error(`Missing account details for account ${this.accountId}`);
            }
            const accountDetails = results.resources[0];
            this.dataSourceId = accountDetails.dataSourceId;
            this.searchEndpoint = accountDetails.searchEndpoint;
            if (!this.searchEndpoint) {
                throw new Error(`Missing search endpoint for account ${this.accountId}`);
            }
            this.generalIndexClient = new SearchClient(this.searchEndpoint, this.dataSourceId, this.defaultCredential, searchDocumentClientOptions);
        } finally {
            cosmosDbClient.dispose();
        }
    }

    async delete(): Promise<void> {
        const indexerClient = new SearchIndexClient(this.searchEndpoint, this.defaultCredential);
        try {
            await indexerClient.deleteIndex(this.dataSourceId);
        } catch (error) {
            console.error(`Error deleting index for data source ${this.dataSourceId}`, error);
            throw error;
        }
    }

    async removeEntries(sourceId: string): Promise<boolean> {
        const currentOrdersIndexIds = await this.titleExistsInGeneralIndex(sourceId);
        if (currentOrdersIndexIds.length > 0) {
            const chunkSize = 10000;
            // Partition into chunks of <= chunkSize
            const idChunks: string[][] = [];
            for (let i = 0; i < currentOrdersIndexIds.length; i += chunkSize) {
                idChunks.push(currentOrdersIndexIds.slice(i, i + chunkSize));
            }
            if (currentOrdersIndexIds.length > chunkSize * 3) {
                console.warn(
                    `Found ${currentOrdersIndexIds.length} entries for sourceId ${sourceId}. ` +
                    `Splitting into ${idChunks.length} batches of up to ${chunkSize} each.`
                );
            }
            for (const ids of idChunks) {
                await this.deleteTitleFromIndex(this.generalIndexClient, ids);
            }
            return true;
        }
        return false;
    }

    private async titleExistsInGeneralIndex(sourceId: string) : Promise<string[]> {
        try {
            const pagedResults = await this.generalIndexClient.search("*", {
                filter: `sourceId eq '${sourceId}'`
            });
            const answers:Array<string> = [];
            for await (const page of pagedResults.results.byPage()) {
                for (const result of page.results) {
                    const id = result.document && 'id' in result.document ? result.document['id'] as string : null;
                    if (!id) {
                        continue;
                    }
                    answers.push(id);
                }
            }
            return answers;
        } catch (error) {
            console.error("Error searching for duplicate documents", error);
            throw error;
        }
    }

    private async deleteTitleFromIndex(client: SearchClient<object>, ids: string[]): Promise<void> {
        try {
            const idRecords = ids.map(id => { return { id: id } });
            await client.deleteDocuments(idRecords, { throwOnAnyFailure: true });
        } catch (error) {
            console.error("Error deleting duplicate documents", error);
            throw error;
        }
    }
}
