INSERT INTO journals (issn,name,fields,policy_url,publisher_host,tier,verified_on)
SELECT '1742-0911',name,fields,'https://www.tandfonline.com/journals/rajc20/about-this-journal',
  publisher_host,tier,'2026-11-19'
FROM journals WHERE issn='1740-6986';

UPDATE papers SET issn='1742-0911' WHERE issn='1740-6986';

UPDATE searches SET journals=replace(journals,'"1740-6986"','"1742-0911"')
WHERE EXISTS(SELECT 1 FROM json_each(searches.journals) WHERE value='1740-6986');

UPDATE search_slices SET
  issn='1742-0911',cursor='*',pages=0,returned=0,omitted=0,total_expected=NULL,
  omissions='{}',error=NULL,restarts=0,done=0
WHERE issn='1740-6986';

UPDATE jobs SET
  id=replace(id,':1740-6986:',':1742-0911:'),
  payload=json_set(payload,'$.issn','1742-0911'),
  status='queued',attempts=0,due=unixepoch()*1000,lease_until=NULL,lease_token=NULL,error=NULL
WHERE kind='discover' AND json_extract(payload,'$.issn')='1740-6986';

DELETE FROM journals WHERE issn='1740-6986';
