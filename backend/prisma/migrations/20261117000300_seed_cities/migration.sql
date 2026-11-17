-- Reference data: cities for the initial (local) market. Idempotent; extend with new migrations.
-- name_en is unique (schema.prisma), so re-running is harmless.
INSERT INTO city (name_ar, name_en, timezone) VALUES
  ('الخليل',        'Hebron',     'Asia/Hebron'),
  ('بيت لحم',       'Bethlehem',  'Asia/Hebron'),
  ('رام الله',      'Ramallah',   'Asia/Hebron'),
  ('القدس',         'Jerusalem',  'Asia/Hebron'),
  ('نابلس',         'Nablus',     'Asia/Hebron'),
  ('جنين',          'Jenin',      'Asia/Hebron'),
  ('طولكرم',        'Tulkarm',    'Asia/Hebron'),
  ('قلقيلية',       'Qalqilya',   'Asia/Hebron'),
  ('سلفيت',         'Salfit',     'Asia/Hebron'),
  ('طوباس',         'Tubas',      'Asia/Hebron'),
  ('أريحا',         'Jericho',    'Asia/Hebron'),
  ('غزة',           'Gaza',       'Asia/Hebron')
ON CONFLICT (name_en) DO NOTHING;
