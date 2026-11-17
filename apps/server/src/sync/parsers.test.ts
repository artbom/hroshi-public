import { describe, expect, it } from 'vitest';

import { parseFlexDate, readFlexRows } from './ibkr/flex.ts';
import type { MonoAccount, MonoStatementItem } from './mono/client.ts';
import { pairOwnCardTransfers } from './mono/own-cards.ts';

const createMonoAccount = (id: string, iban: string): MonoAccount => ({
  id,
  type: 'black',
  currencyCode: 978,
  balance: 0,
  creditLimit: 0,
  maskedPan: [],
  iban,
});

const createMonoItem = (overrides: Partial<MonoStatementItem>): MonoStatementItem => ({
  id: 'item',
  time: 1_790_000_000,
  description: 'Переказ на картку',
  mcc: 4829,
  amount: 0,
  operationAmount: 0,
  currencyCode: 980,
  balance: 0,
  hold: false,
  ...overrides,
});

describe('pairOwnCardTransfers', () => {
  const accounts = [createMonoAccount('white', 'UA-WHITE'), createMonoAccount('black-eur', 'UA-BLACK')];

  it('links the legs of a move between own cards by time and mirrored amounts', () => {
    const paired = pairOwnCardTransfers({
      monoAccounts: accounts,
      statements: new Map([
        ['white', [createMonoItem({ id: 'out', amount: -800_000, operationAmount: -800_000 })]],
        [
          'black-eur',
          [createMonoItem({ id: 'in', time: 1_790_000_030, amount: 15_452, operationAmount: 800_000, description: 'З Білої картки' })],
        ],
      ]),
    });
    expect(paired.get('white')?.[0]?.counterIban).toBe('UA-BLACK');
    expect(paired.get('black-eur')?.[0]?.counterIban).toBe('UA-WHITE');
  });

  it('leaves payments to strangers alone', () => {
    const paired = pairOwnCardTransfers({
      monoAccounts: accounts,
      statements: new Map([['white', [createMonoItem({ id: 'p2p', amount: -2_000_000, operationAmount: -2_000_000 })]]]),
    });
    expect(paired.get('white')?.[0]?.counterIban).toBeUndefined();
  });
});

describe('Flex XML', () => {
  it('reads attribute rows and decodes entities', () => {
    const xml = `<FlexQueryResponse><CashTransactions>
      <CashTransaction type="Deposits/Withdrawals" amount="1202" currency="EUR" fxRateToBase="1.1534" dateTime="20261014;101500" transactionID="77" description="CASH RECEIPTS &amp; TRANSFERS" />
    </CashTransactions></FlexQueryResponse>`;
    expect(readFlexRows(xml, 'CashTransaction')).toEqual([
      {
        type: 'Deposits/Withdrawals',
        amount: '1202',
        currency: 'EUR',
        fxRateToBase: '1.1534',
        dateTime: '20261014;101500',
        transactionID: '77',
        description: 'CASH RECEIPTS & TRANSFERS',
      },
    ]);
  });

  it('does not confuse a container with a row whose name starts the same', () => {
    const xml = '<EquitySummaryInBase><EquitySummaryByReportDateInBase reportDate="2026-11-10" total="12813.61"/></EquitySummaryInBase>';
    expect(readFlexRows(xml, 'EquitySummaryInBase')).toEqual([]);
    expect(readFlexRows(xml, 'EquitySummaryByReportDateInBase')).toEqual([{ reportDate: '2026-11-10', total: '12813.61' }]);
  });

  it.each([
    ['20261110', '2026-11-10'],
    ['2026-11-10', '2026-11-10'],
    ['20261110;235959', '2026-11-10'],
    ['garbage', undefined],
    [undefined, undefined],
  ])('parses %s', (value, expected) => {
    expect(parseFlexDate(value)).toBe(expected);
  });
});
