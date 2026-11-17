import type { RuleInput } from '@hroshi/schema';

type RuleSeed = Partial<RuleInput> & Pick<RuleInput, 'category'>;

/** Overrides that must win over a shorter merchant name ("Uber Eats" before "Uber"). */
const SPECIFIC = 50;
const MERCHANT = 100;
const MCC_FALLBACK = 1000;

const createTransferRules = (accountId: string, patterns: readonly string[]): RuleSeed[] =>
  patterns.map((pattern) => ({ pattern, category: null, transferToAccountId: accountId, priority: SPECIFIC }));

/** Broker deposits and payouts; a card that only ever funds a broker belongs here too, by its last digits. */
const INVESTMENT_TRANSFERS: RuleSeed[] = createTransferRules('freedom24', ['freedom finance', 'tradernet']);

const merchants = (category: string, patterns: readonly string[], priority = MERCHANT): RuleSeed[] =>
  patterns.map((pattern) => ({ pattern, category, priority }));

const mccs = (category: string, codes: readonly number[]): RuleSeed[] =>
  codes.map((mcc) => ({ mcc, category, priority: MCC_FALLBACK }));

export const RULE_SEEDS: readonly RuleSeed[] = [
  ...INVESTMENT_TRANSFERS,
  ...merchants('Кафе і ресторани', ['uber eats', 'uber * eats', 'bolt food'], SPECIFIC),
  ...merchants('Підписки', ['amazon prime', 'apple.com/bill'], SPECIFIC),
  ...merchants('Продукти', ['condis', 'supermercado', 'alcampo', 'mercadona']),
  ...merchants('Кафе і ресторани', ['glovo', "mcdonald's", 'mcdonald’s']),
  ...merchants('Спорт', ['deporvillage', 'decathlon', 'urban sports club']),
  ...merchants('Авто', ['паркінг', 'зелена картка']),
  ...merchants('Транспорт', ['lime', 'bolt', 'uber', 'renfe']),
  ...merchants('Підписки', ['paddle', 'google']),
  ...merchants('Покупки', ['amazon', 'zalando', 'aliexpress', 'tjx', 'tk maxx', 'wallapop']),
  ...merchants("Комуналка і зв'язок", ['vodafone']),
  ...merchants('Податки і збори', ['agencia tributaria', 'гук у м.києві']),
  /** Mono jar top-ups read «Поповнення «<jar>»»; jars are mostly fundraisers. */
  ...merchants('Благодійність', ['банка', 'банку', 'поповнення «']),
  ...merchants('Подорожі', ['emirates', 'ryanair', 'easyjet', 'airbnb', 'state railway', 'vueling']),
  /** Airport duty-free, Mono miles paying back travel, hotel chains. */
  ...merchants('Подорожі', ['avolta', 'компенсація милями', 'premier inn', 'autoroutes']),
  ...merchants('Розваги', ['feverup', 'portaventura']),
  ...merchants('Податки і збори', ['tasas del tesoro', 'списання відсотків']),
  ...mccs('Продукти', [5411, 5412, 5422, 5441, 5451, 5499]),
  ...mccs('Кафе і ресторани', [5811, 5812, 5813, 5814, 5462]),
  ...mccs('Транспорт', [4111, 4112, 4121, 4131, 4789]),
  ...mccs('Авто', [5541, 5542, 5983, 7523, 7542, 7538, 5533]),
  /** 3351–3441 are car-rental brands (SIXT is 3355); rentals only happen on trips. */
  ...mccs('Подорожі', [4511, 4722, 7011, 7512, 3000, 3351, 3355, 3357, 3359, 3366, 3389, 3390, 3393, 3395, 3811]),
  ...mccs("Здоров'я", [5912, 8011, 8021, 8043, 8062, 8099]),
  ...mccs('Особистий догляд', [5977, 7230, 7298]),
  ...mccs('Одяг', [5611, 5621, 5651, 5661, 5691, 5699]),
  ...mccs('Техніка', [5045, 5732, 5734, 5946]),
  ...mccs('Покупки', [5200, 5262, 5310, 5311, 5331, 5399, 5719, 5942, 5945]),
  ...mccs('Підписки', [4899, 5815, 5816, 5817, 5818, 5968]),
  ...mccs("Комуналка і зв'язок", [4814, 4900]),
  ...mccs('Розваги', [7832, 7922, 7991, 7993, 7994, 7996, 7999]),
  ...mccs('Спорт', [5655, 5941, 7941, 7997]),
  ...mccs('Освіта', [8211, 8220, 8241, 8299]),
  ...mccs('Податки і збори', [9222, 9311, 9399]),
  ...mccs('Благодійність', [8398, 8661]),
  ...mccs('Подарунки', [5947, 5992]),
  ...mccs('Послуги', [7210, 7299, 7393, 7631, 7699, 8999]),
];
