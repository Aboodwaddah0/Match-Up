import type { Request, Response } from 'express';
import * as cities from './cities.service';

export const list = async (_req: Request, res: Response) => {
  res.json({ cities: await cities.listCities() });
};
