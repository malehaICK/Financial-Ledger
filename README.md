# Ledger A Finance Management Platform

Ledger is a personal finance management application that helps users track income, expenses, savings, shared expenses, savings goals, and monthly budgets in one place.

The platform is built with a focus on **multi-user support, secure data separation, and privacy-conscious financial document processing**: bank statements and receipt photos are read in the browser and are never uploaded.

## Features

### Income & Expense Tracking

* Add income and expenses manually, with an optional store name or note.
* Fix a mistake with the ✎ pencil on any row: change the date, amount, source, category, or note in place (✓ saves, ✕ cancels). The ✕ on a normal row deletes it.
* Lists show the newest 4 transactions for the month; **Show more** reveals the rest.
* Organize expenses into categories such as groceries, housing, transportation, subscriptions, and more. Each category counts as a Need, Want, or Savings.
* Automatically calculate total income, expenses, savings, and what is left in the account.

### Upload: Receipts, Pay Stubs, Statements, and CSVs

* One upload box on the Budget tab (also **Upload receipt or statement** in the profile) takes photos, PDFs, and CSV files. Several files can be chosen or dragged in at once.
* Ledger works out whether each file is **income or an expense**. Pay stubs, deposits, "you received" transfer confirmations, and refunds count as income; receipts, bills, and purchases count as expenses.
* A single document (one receipt or one pay stub) is added straight away with its date, amount, and a category or source. The result message has **Undo**, and a receipt with several items can be **split by category**.
* A statement with many rows opens a review table first, so each row's type and category can be checked before saving.
* Credit card statements (Visa, Mastercard, Amex) are recognized: purchases and interest or fees become expenses, refunds become income, and payments to the card are left out because that money already left the bank account. The card's own spend category (for example Restaurants) helps pick the category.
* Scanned PDFs without a text layer are read with OCR, like photos.
* The classification is rule-based (keywords, amounts, and statement columns), not a cloud AI model, so files never leave the browser.

### Monthly Budget Dashboard

* View financial activity by month and year.
* Keep transactions associated with their actual transaction date, so one month is never merged into another.
* A **This month** card with a pie chart of needs, wants, and savings.
* Under the totals, a bar for Needs, Wants, and Savings shows dollars spent or saved against each target (for example "Wants: $195.99 of $967.50 · $771.51 left"), followed by a one-line verdict such as "Needs are $312.50 over".
* Targets default to 50 / 30 / 20 of income and can be changed under **Change targets**.

### Calendar

* Sits next to **This month** on the Budget tab.
* A month calendar with a green dot on each day with income, an orange dot on each day with expenses, and the amount spent that day.
* Tap a day to see its transactions; **Add expense** and **Add income** open the form with that date filled in.
* A **Year** view shows income, spending, and what was left for each month.

### Ledger Copilot

Built into the **Ledger Assistant**, following a simple loop: **observe → learn patterns → detect changes → check goals → predict → suggest → you decide**. Ask it "What did you notice?", "What's normal for me?", "What is my income pattern?" or "Any subscriptions?" — nothing is buried in a panel that can be dismissed for good.

* **Learns what's normal:** what each spending category usually costs per month, from up to three earlier months ("Groceries · usually $140–$160 a month").
* **Detects changes and explains them:** flags a category that is noticeably higher than usual and says why, for example "you made 6 purchases in Groceries (usually about 3), and one purchase at Costco ($120.00) was much bigger than your typical $35.00".
* **Finds recurring charges:** flexible charges that repeat every month at about the same amount, with their monthly total.
* **Connects to goals:** estimates how a change affects the savings goal with the nearest target date ("could be pushed back by about 2 weeks").
* **You decide, and nothing is lost:** hidden insights can always be brought back — ask **"show hidden"** to see them, or **"reset alerts"** to restore everything.
* **Learns from your choices:** each ignored spending alert raises how big a jump must be before Ledger mentions it, and "reset alerts" puts that back to normal. Decisions are stored in the browser.
* Rule-based and explainable: every number shown comes from the user's own transactions.

### Income Pattern Reminders

* Learns regular income (the same source arriving weekly, every two weeks, or monthly) and marks the next expected day on the calendar. Ask the Ledger Assistant “What is my income pattern?” to see what it learned.
* Around payday, the Budget tab asks "Did your paycheck arrive?" with a one-tap **Yes, add it**.
* Optional browser notifications, turned on from the profile. There is no push server, so they appear when Ledger is opened around payday.

### Bank Statement Import (PDF or CSV)

* Import text-based PDF statements or CSV exports; files are read locally in the browser.
* PDFs: reads the statement's **Withdrawals** and **Deposits** columns, so withdrawals become expenses and deposits become income. Statements without separate columns fall back to keywords, +/- signs, and the running balance.
* CSVs: works with a signed Amount column, separate Withdrawal/Deposit (Debit/Credit) columns, a Debit/Credit type column, or no header row at all.
* Budget-tracker spreadsheets saved as CSV also work: months across the top with Week 1 / Week 2 / Month Total columns, and separate EXPENSE and INCOME sections. Each filled week becomes one transaction, totals are skipped, and category names such as Rent, Grocery, or Credit Card are matched to Ledger's categories.
* If a file's layout isn't recognized, nothing is added and Ledger explains which layouts it can read.
* After an import, each transaction is saved in its own month. Ledger shows the latest imported month and lists the months that were added.
* Suggests a category for each transaction and shows a review table before anything is saved.
* Detects duplicates, so importing the same statement twice does not add transactions twice.

### Receipt Scanning

* Scan a receipt with the device camera or upload a photo; text recognition (OCR) runs in the browser.
* Fills in the receipt **total** and the **store name** from the top of the receipt.
* Lists the items on the receipt with a suggested category for each (for example groceries, personal care, health). Users can change any category or untick items, then add them as one expense per category. Tax is shared across the categories so they add up to the receipt total.
* The receipt image is never uploaded or stored.

### Shared / Split Expenses

* Mark an expense as **Shared** and enter the total amount paid and your share.
* Only your share counts as your spending; the rest is tracked as money owed back to you.
* **Got it back** records the repayment (full or partial) as income.
* "Left in account" still counts money paid on someone else's behalf, so it always matches the bank balance.

### Savings Goals & Sharing

* Create savings goals with a target amount and date.
* Each goal shows a plan: how much to save per month, whether recent leftover covers it, and which flexible category could close the gap.
* **Share** any goal by emailing an invite or copying an invite link. People who join can see the goal and add savings; only the owner can edit or delete it.
* Owners can remove people or turn off an invite link; members can leave a goal.

### Badges

* Earned for milestones such as a first entry, logging 7 days in a row, saving $100 and $1,000, staying within budget for a month, reaching a goal, and sharing a goal. Badges not earned yet are shown greyed out with what's left to do.

### Next-Month Forecast

* Predicted income, expenses, and remainder for next month, shown on the Goals tab.
* Updates by itself: an average of recent months at first, then, with four or more months of history, a small neural network (TensorFlow.js) trained in the browser whenever the monthly totals change. The model details are not shown in the app.
* Only **complete** months count. The month in progress is half-finished, so including it would drag the estimate down; it is used only when it is the only month with data, and the card says so.
* Income and expense are rounded before the remainder is worked out, so the three numbers always add up.

### Ledger Assistant

* A floating assistant that answers questions such as "Can I afford $100?", "How can I save $500?", or "Where am I spending the most?" using the user's own Ledger data.
* **Affordability** is answered from what is actually left this month (the same figure as "Left in account"), then what the goals need this month, then a small safety buffer. The reply shows each step and says plainly when a purchase fits what's left but takes from goal money, or when the goals were already short before the purchase. With nothing recorded yet this month, it falls back to the recent average and says so.
* Rule-based: nothing typed into it is sent to an AI service.

### Profile

* A profile sheet with the user's initial, name, email, and three numbers: left this month, saved in goals, and goals reached.
* Rename, change password, export data (CSV or PDF), upload a receipt or statement, turn on notifications, delete account, and log out.
* Save and delete confirmations appear as a short message at the top of the screen.
* **Delete account** asks the user to type DELETE, then removes the account and all of its transactions and goals.

### Authentication & Data Isolation

* Individual user accounts with sign in, registration, and password reset.
* Clear messages for common problems, such as signing up with an email that already has an account.
* Each user's transactions and goals are tied to their user ID.
* Database-level Row Level Security prevents users from accessing another user's financial records. Shared goals are visible only to the owner and the people they share with.

### Data Export

From **Export data** in the profile:

* Export transactions as CSV.
* Export a PDF report for the selected month.

### Install as an App

* Includes a web app manifest and offline app shell, so Ledger can be installed from supported browsers when hosted over HTTPS.

## Technology

### Frontend

* HTML5, CSS3, JavaScript (single page, no build step)
* pdf.js — PDF statement reading
* Tesseract.js — receipt OCR
* TensorFlow.js — next-month forecast

### Backend & Database

* Supabase
* PostgreSQL
* Supabase Authentication
* Row Level Security (RLS)
* Supabase Edge Function (`invite-partner`) for goal invite emails

## Architecture

```text
User
  │
  ▼
Ledger Web Application (runs in the browser)
  │
  ├── Budget: manual entry, shared expenses, targets
  ├── Bank statement import (PDF, read locally)
  ├── Receipt scanner (OCR, read locally)
  ├── Goals: plans, forecast, sharing
  └── Ledger Assistant
  │
  ▼
Supabase Authentication
  │
  ▼
Supabase
  │
  ├── PostgreSQL + Row Level Security
  └── Edge Function: invite-partner (sends goal invite emails)
  │
  ▼
User-specific transactions and goals
```

## Security & Privacy

Ledger is designed around the principle of collecting and storing only the financial information required for budgeting.

The database intentionally does not store sensitive information such as:

* Full payment card numbers
* Bank account numbers
* Home addresses
* Receipt images
* Bank statement files

Bank statements and receipts are processed in the browser; only the extracted transaction fields are saved.

The page uses Supabase's **publishable** key, which is designed to be public. Database access is protected by authentication and Row Level Security policies. The Supabase secret key is used only inside the Edge Function and must never be added to the HTML.

> **Important:** This project is currently under development and should not be considered production-ready for real financial information until security, privacy, retention, authentication, and deployment controls have been fully reviewed.

## Database Structure

**transactions** — one row per income or expense:

```text
id
user_id
transaction_date
transaction_type      income | expense
category
source
description
amount                for shared expenses, the user's own share
fingerprint           duplicate detection
gross_amount          full amount paid (shared expenses)
user_share
reimbursement_due     amount still owed back
shared_expense
created_at
```

**savings_goals** — each user's goals (name, target amount, saved amount, target date, status).

**goal_members** — people a goal is shared with (by email).

**goal_invites** — invite link tokens, which the owner can turn off.

Database functions `join_goal` (join through an invite link) and `add_to_goal` (add savings as the owner or a member) enforce who can do what. `delete_my_account` lets signed-in users delete only their own account.

Transactions are separated by:

**User ID** → determines who owns the transaction.

**Transaction date** → determines which month the transaction belongs to.

This prevents August and September transactions from being overwritten or accidentally merged.

## Project Structure

```text
index.html                                   the page (markup)
styles.css                                   all styling
app.js                                       all behaviour
manifest.webmanifest, sw.js, icon.svg        install and offline support
Ledger-database-schema.sql                   full database setup for a new Supabase project
supabase/migrations/20260913_goal_sharing.sql   goal sharing, for projects created earlier
supabase/migrations/20260915_delete_account.sql Delete account, for projects created earlier
supabase/functions/invite-partner/index.ts   Edge Function that emails goal invites
```

## Setup

1. Create a Supabase project.
2. In the Supabase SQL Editor, run `Ledger-database-schema.sql`. For a project set up with an earlier version, run the files in `supabase/migrations/` that it doesn't have yet instead.
3. In `app.js`, set `SUPABASE_URL` and `SUPABASE_ANON_KEY` to your project URL and **publishable** key.
4. Host `index.html`, `styles.css`, `app.js`, `sw.js`, `manifest.webmanifest` and `icon.svg` together over HTTPS (for example GitHub Pages or Netlify). All of them must sit in the same folder, or the page loads unstyled and does nothing.
5. **Authentication → Sign In / Providers → Email**: uncheck **Confirm email**. Accounts then work the moment they are created, with no confirmation message to open. Leave it on only if step 7 (your own email sender) is set up.
6. **Authentication → URL Configuration**: set **Site URL** to the hosted address and add `<address>/**` under **Redirect URLs**. Password reset links point at `http://localhost:3000` until this is done.
7. Optional, for password resets to reach anyone and for goal invite emails: set up a custom SMTP provider (Resend, Brevo, SendGrid) under **Authentication → Emails → SMTP Settings**, then deploy `supabase/functions/invite-partner`. Without it, Supabase's built-in test mailer only delivers to addresses on the project's Supabase team, and goals can still be shared with **Copy invite link**.

## Current Status

**Active Development**

Current functionality includes:

* User authentication, profile, and password reset
* PostgreSQL storage with Row Level Security
* Manual income and expense entry with store names and notes
* Monthly dashboard with a spending pie chart, target bars, and a one-line verdict
* Calendar with month and year views
* Income pattern reminders and optional notifications
* Badges
* PDF and CSV bank statement import (withdrawals and deposits)
* Receipt OCR with item categories
* Shared expenses with repayment tracking
* Savings goals with plans, sharing, and invite links
* Next-month forecast
* Ledger Assistant
* Duplicate detection
* CSV and PDF export

## Author

**Maleha Israt Chowdhury**

Computer Engineering / Computer Science
Canada
