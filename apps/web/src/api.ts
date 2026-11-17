import { z } from 'zod';

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type QueryValue = string | number | boolean | undefined | null;

export const buildQuery = (params: Readonly<Record<string, QueryValue>>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query === '' ? '' : `?${query}`;
};

const ErrorBodySchema = z.object({ message: z.string() });

const readErrorMessage = async (response: Response): Promise<string> => {
  const parsed = ErrorBodySchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.message : `${response.status} ${response.statusText}`;
};

type RequestOptions = {
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
};

const sendRequest = async ({ path, method = 'GET', body }: RequestOptions): Promise<Response> => {
  const response = await fetch(`/api${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new ApiError(await readErrorMessage(response), response.status);
  return response;
};

/** Every response is parsed with the same Zod contract the server validates against. */
export const requestJson = async <TSchema extends z.ZodType>({
  schema,
  ...options
}: RequestOptions & { schema: TSchema }): Promise<z.output<TSchema>> => {
  const response = await sendRequest(options);
  return schema.parse(await response.json());
};

export const requestEmpty = async (options: RequestOptions): Promise<void> => {
  await sendRequest(options);
};

export const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : 'Невідома помилка';
