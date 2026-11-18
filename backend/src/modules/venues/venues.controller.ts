import type { Request, Response } from 'express';
import { actorOf } from '../../middleware/authenticate';
import { valid } from '../../middleware/validate';
import { createVenueSchema, imageParams, imageSchema, staffParams, staffSchema, updateVenueSchema, venueIdParams, venueSearchSchema } from './venues.schemas';
import * as venues from './venues.service';

// ── venues: /venues ──
export const search = async (req: Request, res: Response) => {
  res.json(await venues.searchVenues(valid(req, 'query', venueSearchSchema)));
};

export const mine = async (req: Request, res: Response) => {
  res.json(await venues.myVenues(actorOf(req)));
};

export const create = async (req: Request, res: Response) => {
  res.status(201).json({ venue: await venues.createVenue(actorOf(req), valid(req, 'body', createVenueSchema)) });
};

export const get = async (req: Request, res: Response) => {
  res.json({ venue: await venues.getVenue(actorOf(req), valid(req, 'params', venueIdParams).venueId) });
};

export const update = async (req: Request, res: Response) => {
  const { venueId } = valid(req, 'params', venueIdParams);
  res.json({ venue: await venues.updateVenue(actorOf(req), venueId, valid(req, 'body', updateVenueSchema), String(req.id)) });
};

// ── staff: /venues/:venueId/staff ──
export const listStaff = async (req: Request, res: Response) => {
  res.json(await venues.listStaff(actorOf(req), valid(req, 'params', venueIdParams).venueId));
};

export const addStaff = async (req: Request, res: Response) => {
  const { venueId } = valid(req, 'params', venueIdParams);
  res.status(201).json(await venues.addStaff(actorOf(req), venueId, valid(req, 'body', staffSchema), String(req.id)));
};

export const removeStaff = async (req: Request, res: Response) => {
  const { venueId, userId } = valid(req, 'params', staffParams);
  await venues.removeStaff(actorOf(req), venueId, userId, String(req.id));
  res.status(204).end();
};

// ── images: /venues/:venueId/images ──
export const addImage = async (req: Request, res: Response) => {
  const { venueId } = valid(req, 'params', venueIdParams);
  res.status(201).json(await venues.addImage(actorOf(req), venueId, valid(req, 'body', imageSchema).url, String(req.id)));
};

export const removeImage = async (req: Request, res: Response) => {
  const { venueId, imageId } = valid(req, 'params', imageParams);
  await venues.removeImage(actorOf(req), venueId, imageId, String(req.id));
  res.status(204).end();
};
