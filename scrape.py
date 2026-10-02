import pandas as pd
from jobspy import scrape_jobs

terms = ["digital marketing", "social media manager", "SEO executive", "performance marketing"]
cities = ["Raipur, India", "Bhilai, India", "Durg, India"]

frames = []
for t in terms:
    for c in cities:
        try:
            df = scrape_jobs(site_name=["indeed"], search_term=t, location=c,
                             results_wanted=20, hours_old=72, country_indeed="India")
            df["search"] = t
            frames.append(df)
        except Exception as e:
            print("skip", t, c, e)

jobs = pd.concat(frames, ignore_index=True)
leads = (jobs[["company", "title", "location", "job_url", "search"]]
         .drop_duplicates("company"))
leads.to_csv("leads.csv", index=False)
print(f"Saved {len(leads)} leads")
