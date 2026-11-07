import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findDuplicateProducts,
  getPriceForCustomerType,
  computeProductMargins,
  normalizeAutomotiveProduct,
  matchProductToMaster,
} from '../src/utils/products.js';
import {
  buildDoubleEntryBook,
  ACCOUNT_GROUPS,
  VOUCHER_TYPES,
  SYSTEM_LEDGERS,
} from '../src/utils/accounting.js';
import {
  parseBusyFileRecords,
  reconcileBusyImport,
  SAMPLE_BUSY_MASTERS_DAT,
} from '../src/utils/busyParser.js';

test('Automotive Product: Brand-Aware Duplicate Detection', () => {
  const existing = [
    { id: '1', name: 'Front Brake Pad', oemPartNo: 'BP-001', brand: 'Bosch' },
    { id: '2', name: 'Oil Filter', oemPartNo: 'OF-505', brand: 'Purolator' },
  ];

  // 1. Same part number AND same brand => Duplicate detected
  const dupCandidate = { name: 'Brake Pad Set', oemPartNo: 'bp-001', brand: 'BOSCH' };
  const res1 = findDuplicateProducts(dupCandidate, existing);
  assert.equal(res1.exactDuplicates.length, 1, 'Should match duplicate when partNumber and brand match');
  assert.equal(res1.exactDuplicates[0].product.id, '1');

  // 2. Same part number BUT different brand => NOT a duplicate (Cross-brand equivalent)
  const crossBrandCandidate = { name: 'Brake Pad Set TVS', oemPartNo: 'BP-001', brand: 'TVS Girling' };
  const res2 = findDuplicateProducts(crossBrandCandidate, existing);
  assert.equal(res2.exactDuplicates.length, 0, 'Must NOT merge same part numbers from different brands');
  assert.equal(res2.crossBrandEquivalents.length, 1, 'Should record as cross-brand equivalent');

  // 3. Different part number => NOT a duplicate
  const uniqueCandidate = { name: 'Air Filter', oemPartNo: 'AF-999', brand: 'Bosch' };
  const res3 = findDuplicateProducts(uniqueCandidate, existing);
  assert.equal(res3.exactDuplicates.length, 0);
  assert.equal(res3.crossBrandEquivalents.length, 0);
});

test('Automotive Product: Customer Type Price-Tier Resolution', () => {
  const product = {
    sellingPrice: 1000,
    mrp: 1200,
    mechanicPrice: 850,
    wholesalePrice: 800,
    specialPrice: 750,
    purchasePrice: 600,
  };

  assert.equal(getPriceForCustomerType(product, 'Retail').price, 1000, 'Retail gets standard selling price');
  assert.equal(getPriceForCustomerType(product, 'Mechanic').price, 850, 'Mechanic gets mechanic price');
  assert.equal(getPriceForCustomerType(product, 'Garage').price, 850, 'Garage gets mechanic price tier');
  assert.equal(getPriceForCustomerType(product, 'Workshop').price, 850, 'Workshop gets mechanic price tier');
  assert.equal(getPriceForCustomerType(product, 'Wholesaler').price, 800, 'Wholesaler gets wholesale price');
  assert.equal(getPriceForCustomerType(product, 'Dealer').price, 800, 'Dealer gets wholesale price tier');
  assert.equal(getPriceForCustomerType(product, 'Special').price, 750, 'Special gets special price');
  assert.equal(getPriceForCustomerType(product, 'Other').price, 1000, 'Fallback to standard selling price');
});

test('Double-Entry Accounting: Self-Balancing Trial Balance and Daybook', () => {
  const profile = { businessName: 'Auto Spares Hub', gstin: '07AAAAA0000A1Z5' };

  const bills = [
    {
      id: 'inv-1',
      invoiceNumber: 'INV-2026-001',
      invoiceDate: '2026-11-01',
      clientName: 'Speedy Garage',
      status: 'unpaid',
      data: {
        total: 1180,
        taxAmount: 180,
        subTotal: 1000,
        paymentMode: 'credit',
      },
    },
    {
      id: 'inv-2',
      invoiceNumber: 'INV-2026-002',
      invoiceDate: '2026-11-02',
      clientName: 'Walk-in Retail',
      status: 'paid',
      data: {
        total: 590,
        taxAmount: 90,
        subTotal: 500,
        paymentMode: 'cash',
      },
    },
  ];

  const purchases = [
    {
      id: 'pur-1',
      billNumber: 'PB-2026-101',
      date: '2026-10-25',
      supplierName: 'Bosch Auto Parts Dist.',
      totalAmount: 2360,
      cgst: 180,
      sgst: 180,
      paymentStatus: 'paid',
      payments: [{ amount: 2360, mode: 'Bank', date: '2026-10-25' }],
    },
  ];

  const vouchers = [
    {
      id: 'vch-1',
      voucherNo: 'RCT-001',
      voucherType: 'Receipt',
      date: '2026-11-03',
      debitAccountId: 'sys_bank',
      creditAccountId: 'ledger_speedy_garage',
      amount: 1180,
      narration: 'Full settlement from Speedy Garage',
    },
  ];

  const ledgers = [
    { id: 'ledger_speedy_garage', name: 'Speedy Garage', group: 'Sundry Debtors', openingBalance: 0, openingType: 'Dr' },
  ];

  const book = buildDoubleEntryBook({ bills, purchases, vouchers, ledgers, profile });

  // 1. Daybook must contain balanced postings
  assert.ok(book.daybook.length > 0, 'Daybook entries should be present');
  for (const entry of book.daybook) {
    const sumDr = entry.lines.reduce((s, l) => s + (l.debit || 0), 0);
    const sumCr = entry.lines.reduce((s, l) => s + (l.credit || 0), 0);
    assert.ok(Math.abs(sumDr - sumCr) < 0.01, `Voucher ${entry.voucherNo} must balance: Dr ${sumDr} === Cr ${sumCr}`);
  }

  // 2. Trial Balance must balance: Total Debit === Total Credit
  assert.ok(
    Math.abs(book.trialBalance.totalDebit - book.trialBalance.totalCredit) < 0.01,
    `Trial Balance must balance: Debit ${book.trialBalance.totalDebit} === Credit ${book.trialBalance.totalCredit}`
  );

  // 3. Balance sheet Assets and Liabilities match
  assert.equal(
    book.balanceSheet.assets.total,
    book.balanceSheet.liabilities.total,
    'Balance Sheet total assets must equal total liabilities'
  );
});

test('BUSY Accounting: .DAT Parser and Strict Mathematical Reconciliation', () => {
  // Parse the sample BUSY .DAT master content
  const records = parseBusyFileRecords('SAMPLE_MASTERS.DAT', SAMPLE_BUSY_MASTERS_DAT);
  assert.ok(records.length > 0, 'Parsed records should not be empty');

  const existingProducts = [{ oemPartNo: 'OF-770', brand: 'Mann' }];
  const existingClients = [];
  const existingSuppliers = [];

  const recon = reconcileBusyImport({
    records,
    existingProducts,
    existingClients,
    existingSuppliers,
  });

  // Verify total source equality
  assert.equal(recon.counts.reconciled, true, 'Import batch must be mathematically reconciled');
  assert.equal(
    recon.counts.totalSource,
    recon.counts.accountedFor,
    'totalSource must equal accountedFor'
  );

  assert.ok(recon.counts.newCount >= 1, 'Should detect new masters');
});
