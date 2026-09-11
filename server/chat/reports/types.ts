export interface ReportQueryParams {
  queryType?: string;
  entityName?: string;
  locationName?: string;
  containerNumber?: string;
  containerStatus?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  [key: string]: unknown;
}

export interface DataQueryContext {
  companyId: number;
  params: ReportQueryParams;
  dateFrom: string;
  dateTo: string;
  todayStr: string;
  todayDate: Date;
  thisMonthStart: string;
  lastMonthStart: string;
  lastMonthEnd: string;
  rowLimit: number;
  userMessage: string;
  fmt: (n: number) => string;
  fmtDec: (n: number) => string;
}

export type DataQueryResult = Record<string, unknown> | undefined;

export interface ReportImplementationShard {
  readonly name: string;
  readonly queryTypes: readonly string[];
  run(ctx: DataQueryContext): Promise<DataQueryResult>;
}

export interface ReportDomainHandler {
  readonly domain: string;
  readonly queryTypes: readonly string[];
  handles(queryType: string): boolean;
  run(ctx: DataQueryContext): Promise<DataQueryResult>;
}
