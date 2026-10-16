export const DEFAULT_RESPONSE_MAX_CHARS = 16_000;

/** Matches the indented JSON text emitted by the MCP server. */
export const serializedResponseChars = (value: unknown) => JSON.stringify(value, null, 2).length;

export interface BoundedPageInfo<T> {
  rows: T[];
  returnedRows: number;
  hasMore: boolean;
  nextOffset: number | null;
  responseSizeLimited: boolean;
  pageLimitReason: "response_size" | "row_limit" | null;
  responseMaxChars: number;
}

interface BoundedPageOptions<T, TResult> {
  candidates: T[];
  limit: number;
  offset: number;
  responseMaxChars?: number;
  build: (page: BoundedPageInfo<T>) => TResult;
  oversizedRowHint: string;
}

/**
 * Fits complete rows into a bounded JSON response. A row is never partially
 * serialized: callers either receive it intact or get an actionable error that
 * tells them to reduce the selected fields.
 */
export function buildBoundedPage<T, TResult>({
  candidates,
  limit,
  offset,
  responseMaxChars = DEFAULT_RESPONSE_MAX_CHARS,
  build,
  oversizedRowHint,
}: BoundedPageOptions<T, TResult>): TResult {
  const requestedRows = candidates.slice(0, limit);
  const upstreamHasMore = candidates.length > limit;
  const accepted: T[] = [];

  const pageInfo = (rows: T[]): BoundedPageInfo<T> => {
    const responseSizeLimited = rows.length < requestedRows.length;
    const hasMore = responseSizeLimited || upstreamHasMore;
    return {
      rows,
      returnedRows: rows.length,
      hasMore,
      nextOffset: hasMore ? offset + rows.length : null,
      responseSizeLimited,
      pageLimitReason: responseSizeLimited ? "response_size" : upstreamHasMore ? "row_limit" : null,
      responseMaxChars,
    };
  };

  for (const row of requestedRows) {
    const trial = [...accepted, row];
    if (serializedResponseChars(build(pageInfo(trial))) > responseMaxChars) break;
    accepted.push(row);
  }

  if (requestedRows.length > 0 && accepted.length === 0) {
    const rowChars = JSON.stringify(requestedRows[0]).length;
    throw new Error(
      `Row at offset ${offset} cannot fit responseMaxChars=${responseMaxChars} (rowChars=${rowChars}); ${oversizedRowHint}`,
    );
  }

  const result = build(pageInfo(accepted));
  if (serializedResponseChars(result) > responseMaxChars) {
    throw new Error(`Response metadata cannot fit responseMaxChars=${responseMaxChars}; increase responseMaxChars`);
  }
  return result;
}
