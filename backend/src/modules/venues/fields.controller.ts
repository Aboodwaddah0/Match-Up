import type { Request, Response } from 'express';
import { actorOf } from '../../middleware/authenticate';
import { valid } from '../../middleware/validate';
import * as fields from './fields.service';
import {
  availabilitySchema,
  blockIdParams,
  createBlockSchema,
  createFieldSchema,
  fieldIdParams,
  listBlocksSchema,
  openingHoursSchema,
  updateFieldSchema,
  venueIdParams,
} from './venues.schemas';

// ── fields: created under a venue, then addressed by their own id ──
export const create = async (req: Request, res: Response) => {
  const { venueId } = valid(req, 'params', venueIdParams);
  res.status(201).json(await fields.createField(actorOf(req), venueId, valid(req, 'body', createFieldSchema)));
};

export const update = async (req: Request, res: Response) => {
  const { fieldId } = valid(req, 'params', fieldIdParams);
  res.json(await fields.updateField(actorOf(req), fieldId, valid(req, 'body', updateFieldSchema)));
};

export const setOpeningHours = async (req: Request, res: Response) => {
  const { fieldId } = valid(req, 'params', fieldIdParams);
  res.json(await fields.setOpeningHours(actorOf(req), fieldId, valid(req, 'body', openingHoursSchema)));
};

export const availability = async (req: Request, res: Response) => {
  const { fieldId } = valid(req, 'params', fieldIdParams);
  res.json(await fields.getAvailability(fieldId, valid(req, 'query', availabilitySchema).date));
};

// ── blocks (unavailable time; not bookings) ──
export const listBlocks = async (req: Request, res: Response) => {
  const { fieldId } = valid(req, 'params', fieldIdParams);
  res.json(await fields.listBlocks(actorOf(req), fieldId, valid(req, 'query', listBlocksSchema).from));
};

export const createBlock = async (req: Request, res: Response) => {
  const { fieldId } = valid(req, 'params', fieldIdParams);
  res.status(201).json(await fields.createBlock(actorOf(req), fieldId, valid(req, 'body', createBlockSchema)));
};

export const deleteBlock = async (req: Request, res: Response) => {
  await fields.deleteBlock(actorOf(req), valid(req, 'params', blockIdParams).blockId);
  res.status(204).end();
};
