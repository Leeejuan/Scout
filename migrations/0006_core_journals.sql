INSERT OR IGNORE INTO journals (issn,name,fields,policy_url,publisher_host,tier,verified_on) VALUES
 ('0363-8111','Public Relations Review','["strategic-pr"]','https://www.sciencedirect.com/journal/public-relations-review/about/aims-and-scope',NULL,'expanded','2026-11-19'),
 ('1553-118X','International Journal of Strategic Communication','["strategy"]','https://www.tandfonline.com/journals/hstc20/about-this-journal',NULL,'expanded','2026-11-19'),
 ('1058-4609','Political Communication','["political"]','https://www.tandfonline.com/journals/upcp20/about-this-journal',NULL,'expanded','2026-11-19'),
 ('1352-7266','Journal of Marketing Communications','["marketing"]','https://www.tandfonline.com/journals/rjmc20/about-this-journal',NULL,'expanded','2026-11-19'),
 ('1751-3057','Journal of International and Intercultural Communication','["global","intercultural"]','https://www.tandfonline.com/journals/rjii20/about-this-journal',NULL,'expanded','2026-11-19'),
 ('1046-4964','Small Group Research','["groups"]','https://journals.sagepub.com/author-instructions/sgr',NULL,'expanded','2026-11-19'),
 ('1520-5436','Mass Communication and Society','["mass"]','https://www.tandfonline.com/journals/hmcs20/about-this-journal',NULL,'expanded','2026-11-19'),
 ('1366-9877','Journal of Risk Research','["risk"]','https://www.tandfonline.com/journals/rjrr20/about-this-journal',NULL,'expanded','2026-11-19'),
 ('0265-4075','Journal of Social and Personal Relationships','["interpersonal"]','https://journals.sagepub.com/author-instructions/spr',NULL,'expanded','2026-11-19');

UPDATE journals SET fields=json_insert(fields,'$[#]','health') WHERE issn='1087-0415';
UPDATE journals SET fields=json_insert(fields,'$[#]','environment') WHERE issn='1752-4040';
UPDATE journals SET fields=json_insert(fields,'$[#]','strategy') WHERE issn='1552-6798';
