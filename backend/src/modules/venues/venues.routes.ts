import { Router } from 'express';
import { authenticate, requireVerifiedEmail } from '../../middleware/authenticate';
import { createFieldLimiter, createVenueLimiter } from '../../middleware/rate-limit';
import { validate } from '../../middleware/validate';
import * as fields from './fields.controller';
import * as venues from './venues.controller';
import {
  availabilitySchema,
  blockIdParams,
  createBlockSchema,
  createFieldSchema,
  createVenueSchema,
  fieldIdParams,
  imageParams,
  imageSchema,
  listBlocksSchema,
  openingHoursSchema,
  staffParams,
  staffSchema,
  updateFieldSchema,
  updateVenueSchema,
  venueIdParams,
  venueSearchSchema,
} from './venues.schemas';

// Permissions (owner / staff / admin) are checked per venue inside the services, not here.

// ───────── /api/v1/venues ─────────
export const venuesRouter = Router();
venuesRouter.use(authenticate);

venuesRouter.get('/', validate({ query: venueSearchSchema }), venues.search);
venuesRouter.get('/mine', venues.mine);
venuesRouter.post('/', requireVerifiedEmail, createVenueLimiter, validate({ body: createVenueSchema }), venues.create);
venuesRouter.get('/:venueId', validate({ params: venueIdParams }), venues.get);
venuesRouter.patch('/:venueId', validate({ params: venueIdParams, body: updateVenueSchema }), venues.update);

venuesRouter.post('/:venueId/fields', createFieldLimiter, validate({ params: venueIdParams, body: createFieldSchema }), fields.create);

venuesRouter.get('/:venueId/staff', validate({ params: venueIdParams }), venues.listStaff);
venuesRouter.post('/:venueId/staff', validate({ params: venueIdParams, body: staffSchema }), venues.addStaff);
venuesRouter.delete('/:venueId/staff/:userId', validate({ params: staffParams }), venues.removeStaff);

venuesRouter.post('/:venueId/images', validate({ params: venueIdParams, body: imageSchema }), venues.addImage);
venuesRouter.delete('/:venueId/images/:imageId', validate({ params: imageParams }), venues.removeImage);

// ───────── /api/v1/fields ─────────
export const fieldsRouter = Router();
fieldsRouter.use(authenticate);

fieldsRouter.patch('/:fieldId', validate({ params: fieldIdParams, body: updateFieldSchema }), fields.update);
fieldsRouter.put('/:fieldId/opening-hours', validate({ params: fieldIdParams, body: openingHoursSchema }), fields.setOpeningHours);
fieldsRouter.get('/:fieldId/availability', validate({ params: fieldIdParams, query: availabilitySchema }), fields.availability);
fieldsRouter.get('/:fieldId/blocks', validate({ params: fieldIdParams, query: listBlocksSchema }), fields.listBlocks);
fieldsRouter.post('/:fieldId/blocks', validate({ params: fieldIdParams, body: createBlockSchema }), fields.createBlock);

// ───────── /api/v1/blocks ─────────
export const blocksRouter = Router();
blocksRouter.use(authenticate);
blocksRouter.delete('/:blockId', validate({ params: blockIdParams }), fields.deleteBlock);
