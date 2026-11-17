/** Fastify answers with `statusCode` and the message instead of a 500. */
const createHttpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

export const badRequest = (message: string) => createHttpError(400, message);

export const notFound = (message: string) => createHttpError(404, message);

export const conflict = (message: string) => createHttpError(409, message);
