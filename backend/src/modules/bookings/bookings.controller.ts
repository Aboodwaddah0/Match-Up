import type { Request, Response } from 'express';
import { actorOf } from '../../middleware/authenticate';
import { valid } from '../../middleware/validate';
import {
  bookingIdParams,
  createBookingSchema,
  externalBookingSchema,
  myBookingsSchema,
  reasonSchema,
  venueBookingsSchema,
  venueIdParams,
} from './bookings.schemas';
import * as bookings from './bookings.service';

// ── requester side: /bookings ──
export const create = async (req: Request, res: Response) => {
  res.status(201).json(await bookings.createBooking(actorOf(req), valid(req, 'body', createBookingSchema)));
};

export const createExternal = async (req: Request, res: Response) => {
  res.status(201).json(await bookings.createExternalBooking(actorOf(req), valid(req, 'body', externalBookingSchema)));
};

export const mine = async (req: Request, res: Response) => {
  res.json(await bookings.myBookings(actorOf(req), valid(req, 'query', myBookingsSchema)));
};

export const get = async (req: Request, res: Response) => {
  res.json(await bookings.getBooking(actorOf(req), valid(req, 'params', bookingIdParams).bookingId));
};

export const cancel = async (req: Request, res: Response) => {
  const { bookingId } = valid(req, 'params', bookingIdParams);
  res.json(await bookings.cancelBooking(actorOf(req), bookingId, valid(req, 'body', reasonSchema).reason, String(req.id)));
};

// ── venue staff answer requests: /bookings/:id/confirm | reject ──
export const confirm = async (req: Request, res: Response) => {
  res.json(await bookings.confirmBooking(actorOf(req), valid(req, 'params', bookingIdParams).bookingId, String(req.id)));
};

export const reject = async (req: Request, res: Response) => {
  const { bookingId } = valid(req, 'params', bookingIdParams);
  res.json(await bookings.rejectBooking(actorOf(req), bookingId, valid(req, 'body', reasonSchema).reason, String(req.id)));
};

// ── venue inbox: /venues/:venueId/bookings ──
export const venueInbox = async (req: Request, res: Response) => {
  const { venueId } = valid(req, 'params', venueIdParams);
  res.json(await bookings.venueBookings(actorOf(req), venueId, valid(req, 'query', venueBookingsSchema)));
};
