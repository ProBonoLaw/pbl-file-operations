export interface DataIngestionResponse {
    indexes: string[];
    superseded?: boolean;
}

export interface DataRemovalResponse {
    removedFromGeneralIndex: boolean;
}
