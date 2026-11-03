# Setting up NYC Rental Scores

Everything here is free. There are four parts. Parts 1 and 2 take about 10 minutes each.

---

## Part 1 — Turn on the website

1. Open **github.com/nyc-rental-scores/nyc-rental-scores**.
2. Click **Settings** (top row of tabs, far right).
3. In the left menu, click **Pages**.
4. Under **Build and deployment → Source**, choose **GitHub Actions**.
5. Click the **Actions** tab (top row). Click **Refresh listings and publish site** on the left, then the **Run workflow** button on the right, then the green **Run workflow**.
6. After about two minutes your site is live at
   **https://nyc-rental-scores.github.io/nyc-rental-scores/**

The "check any building" box works right away. Listings appear after Parts 2 and 3.

---

## Part 2 — The inbox that collects listings

Use a separate Gmail account for this (for example a new one like `nycrentalscores@gmail.com`), so alert emails never mix with your own mail.

1. Signed in to that Gmail account, go to **sheets.new** to create a blank Google Sheet. Name it **NYC Rental Scores listings**.
2. In the sheet's menu: **Extensions → Apps Script**. A code editor opens.
3. Delete everything in the editor. Open
   **github.com/nyc-rental-scores/nyc-rental-scores/blob/main/apps-script/ListingAlerts.gs**,
   click the **copy** icon (two squares, top right of the code), and paste it into the editor.
4. Click the **save** icon (floppy disk).
5. In the drop-down next to **Run**, pick **setup**, then click **Run**.
6. Google asks for permission. Click **Review permissions**, pick the account, then **Advanced → Go to … (unsafe) → Allow**. ("Unsafe" only means Google hasn't reviewed it. It's your own script, and it only reads alert emails and writes to this sheet.)
7. Back in the sheet you'll see two new tabs: **Listings** and **Unreadable emails**.
8. Publish the Listings tab so the website can read it: **File → Share → Publish to web**. In the first drop-down choose **Listings**, in the second choose **Comma-separated values (.csv)**, click **Publish**, then **OK**. Copy the link it shows.
9. On GitHub: **Settings → Secrets and variables → Actions → Variables tab → New repository variable**.
   Name: `LISTINGS_CSV_URL`. Value: the link you copied. Click **Add variable**.

The script now checks the inbox every 15 minutes, and the website refreshes every hour.

---

## Part 3 — StreetEasy alerts

1. Go to **streeteasy.com** and sign up or sign in **with the Gmail account from Part 2**.
2. Search **Rentals** in **Manhattan** with no price or bedroom limits. Click **Save search**, and set notifications to **Instant** email.
3. Repeat for **Brooklyn**, **Queens**, **Bronx** and **Staten Island**.
4. If StreetEasy alert emails say "and more listings" (meaning they're cut short), split the busiest boroughs into smaller searches. For example, split Manhattan into rent under $3,500, $3,500–$5,000 and over $5,000.

**Optional, same idea:** saved searches with email alerts on Craigslist (apartments/housing for rent), RentHop, Zillow, NYBits or Apartments.com, all sent to the same Gmail. The script already recognizes these senders.

**If listings don't show up:** look at the **Unreadable emails** tab in the sheet. Any alert email the script couldn't read lands there. Share one with Claude and the reader can be adjusted.

---

## Part 4 (optional) — A free key for the city's data

The city's data site limits how often anonymous users can ask for data. A free key raises the limit, which helps once there are thousands of listings.

1. Create a free account at **data.cityofnewyork.us** (Sign in → Sign up).
2. Go to your profile → **Developer settings → Create new app token**. Copy the **App Token**.
3. On GitHub: **Settings → Secrets and variables → Actions → Secrets tab → New repository secret**.
   Name: `SODA_APP_TOKEN`. Value: the token.
