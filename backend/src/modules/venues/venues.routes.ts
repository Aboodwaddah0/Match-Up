import { Router } from 'express';
import { authenticate, requireVerifiedEmail } from '../../middleware/authenticate';
import * as fields from './fields.service';
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
import * as venues from './venues.service';

const actor = (req: { auth?: { userId: string; role: 'USER' | 'ADMIN' } }) => ({ userId: req.auth!.userId, role: req.auth!.role });

// ───────── /api/v1/venues ─────────
export const venuesRouter = Router();
venuesRouter.use(authenticate);

venuesRouter.get('/', async (req, res) => {
  res.json(await venues.searchVenues(venueSearchSchema.parse(req.query)));
});
venuesRouter.get('/mine', async (req, res) => {
  res.json(await venues.myVenues(actor(req)));
});
venuesRouter.post('/', requireVerifiedEmail, async (req, res) => {
  res.status(201).json({ venue: await venues.createVenue(actor(req), createVenueSchema.parse(req.body)) });
});
venuesRouter.get('/:venueId', async (req, res) => {
  const { venueId } = venueIdParams.parse(req.params);
  res.json({ venue: await venues.getVenue(actor(req), venueId) });
});
venuesRouter.patch('/:venueId', async (req, res) => {
  const { venueId } = venueIdParams.parse(req.params);
  res.json({ venue: await venues.updateVenue(actor(req), venueId, updateVenueSchema.parse(req.body)) });
});

venuesRouter.post('/:venueId/fields', async (req, res) => {
  const { venueId } = venueIdParams.parse(req.params);
  res.status(201).json(await fields.createField(actor(req), venueId, createFieldSchema.parse(req.body)));
});

venuesRouter.get('/:venueId/staff', async (req, res) => {
  const { venueId } = venueIdParams.parse(req.params);
  res.json(await venues.listStaff(actor(req), venueId));
});
venuesRouter.post('/:venueId/staff', async (req, res) => {
  const { venueId } = venueIdParams.parse(req.params);
  res.status(201).json(await venues.addStaff(actor(req), venueId, staffSchema.parse(req.body)));
});
venuesRouter.delete('/:venueId/staff/:userId', async (req, res) => {
  const { venueId, userId } = staffParams.parse(req.params);
  await venues.removeStaff(actor(req), venueId, userId);
  res.status(204).end();
});

venuesRouter.post('/:venueId/images', async (req, res) => {
  const { venueId } = venueIdParams.parse(req.params);
  res.status(201).json(await venues.addImage(actor(req), venueId, imageSchema.parse(req.body).url));
});
venuesRouter.delete('/:venueId/images/:imageId', async (req, res) => {
  const { venueId, imageId } = imageParams.parse(req.params);
  await venues.removeImage(actor(req), venueId, imageId);
  res.status(204).end();
});

// ───────── /api/v1/fields ─────────
export const fieldsRouter = Router();
fieldsRouter.use(authenticate);

fieldsRouter.patch('/:fieldId', async (req, res) => {
  const { fieldId } = fieldIdParams.parse(req.params);
  res.json(await fields.updateField(actor(req), fieldId, updateFieldSchema.parse(req.body)));
});
fieldsRouter.put('/:fieldId/opening-hours', async (req, res) => {
  const { fieldId } = fieldIdParams.parse(req.params);
  res.json(await fields.setOpeningHours(actor(req), fieldId, openingHoursSchema.parse(req.body)));
});
fieldsRouter.get('/:fieldId/availability', async (req, res) => {
  const { fieldId } = fieldIdParams.parse(req.params);
  res.json(await fields.getAvailability(fieldId, availabilitySchema.parse(req.query).date));
});
fieldsRouter.get('/:fieldId/blocks', async (req, res) => {
  const { fieldId } = fieldIdParams.parse(req.params);
  res.json(await fields.listBlocks(actor(req), fieldId, listBlocksSchema.parse(req.query).from));
});
fieldsRouter.post('/:fieldId/blocks', async (req, res) => {
  const { fieldId } = fieldIdParams.parse(req.params);
  res.status(201).json(await fields.createBlock(actor(req), fieldId, createBlockSchema.parse(req.body)));
});

// ───────── /api/v1/blocks ─────────
export const blocksRouter = Router();
blocksRouter.use(authenticate);
blocksRouter.delete('/:blockId', async (req, res) => {
  const { blockId } = blockIdParams.parse(req.params);
  await fields.deleteBlock(actor(req), blockId);
  res.status(204).end();
});
