import { type ConsentCompletion, ConsentCompletionSchema } from '@hroshi/schema';

/**
 * The code and state from the address the bank redirected to after consent. When nothing listens
 * on the redirect address (https://localhost), the owner copies it from the browser.
 */
export const parseConsentRedirect = (text: string): ConsentCompletion | undefined => {
  if (!URL.canParse(text.trim())) return undefined;
  const { searchParams } = new URL(text.trim());
  return ConsentCompletionSchema.safeParse({ code: searchParams.get('code'), state: searchParams.get('state') }).data;
};
