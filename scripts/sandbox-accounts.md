# Sandbox accounts (manual, one time)

PayPal sandbox accounts and REST apps are created in the developer dashboard by you; nothing here automates sign-up.
Sandbox only. All values go in `.env` (gitignored), never in code.

1. **developer.paypal.com → Testing Tools → Sandbox Accounts → Create account**:
   - `quorum-coop` — **Business**, country **US**. This is the coordinator / merchant of record.
   - `quorum-supplier` — **Business**, country **US**. The supplier (third-party payee).
   - `member-1` … `member-4` — **Personal**, country **US**. Human approvals in the PayPal popup.
2. **Supplier merchant ID**: Sandbox Accounts → `quorum-supplier` → View/Edit → *Account ID* → `SUPPLIER_MERCHANT_ID`.
3. **Apps & Credentials (Sandbox) → Create App**:
   - App `quorum-coordinator`, linked to `quorum-coop` → `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`.
   - App `quorum-supplier`, linked to `quorum-supplier` → `SUPPLIER_PAYPAL_CLIENT_ID`, `SUPPLIER_PAYPAL_CLIENT_SECRET`.
   - In the coordinator app's features, make sure **Advanced Credit and Debit Card Payments** is on (needed for card-funded bot authorizations, R2).
4. **Testing Tools → Credit Card Generator** (US, Visa) → `SANDBOX_CARD_NUMBER`, `SANDBOX_CARD_EXPIRY` (`YYYY-MM`), `SANDBOX_CARD_CVV`.
5. Run R1:

   ```bash
   corepack pnpm test:sandbox
   ```

   Findings are written to `spikes/r1/results.json`. Then run the manual wallet variant
   (approve as `member-1` in the browser):

   ```bash
   node --env-file=.env --import tsx spikes/r1/wallet.ts
   ```
