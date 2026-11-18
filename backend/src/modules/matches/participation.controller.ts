import type { Request, Response } from 'express';
import { actorOf } from '../../middleware/authenticate';
import { valid } from '../../middleware/validate';
import { attendanceSchema, createRequestSchema, inviteSchema, matchIdParams, participantParams, requestParams } from './matches.schemas';
import * as participation from './participation.service';

// ── join requests (the ASK; never counts toward capacity) ──
export const createRequest = async (req: Request, res: Response) => {
  const { matchId } = valid(req, 'params', matchIdParams);
  const { message } = valid(req, 'body', createRequestSchema);
  res.status(201).json(await participation.createRequest(actorOf(req), matchId, message));
};

export const withdrawRequest = async (req: Request, res: Response) => {
  await participation.withdrawRequest(actorOf(req), valid(req, 'params', matchIdParams).matchId);
  res.status(204).end();
};

export const listRequests = async (req: Request, res: Response) => {
  res.json(await participation.listPendingRequests(actorOf(req), valid(req, 'params', matchIdParams).matchId));
};

export const acceptRequest = async (req: Request, res: Response) => {
  const { matchId, requestId } = valid(req, 'params', requestParams);
  res.json(await participation.decideRequest(actorOf(req), matchId, requestId, 'accept', String(req.id)));
};

export const rejectRequest = async (req: Request, res: Response) => {
  const { matchId, requestId } = valid(req, 'params', requestParams);
  res.json(await participation.decideRequest(actorOf(req), matchId, requestId, 'reject', String(req.id)));
};

// ── participants (CONFIRMED membership) ──
export const listParticipants = async (req: Request, res: Response) => {
  res.json(await participation.listParticipants(actorOf(req), valid(req, 'params', matchIdParams).matchId));
};

export const leave = async (req: Request, res: Response) => {
  res.json(await participation.leaveMatch(actorOf(req), valid(req, 'params', matchIdParams).matchId));
};

export const removeParticipant = async (req: Request, res: Response) => {
  const { matchId, userId } = valid(req, 'params', participantParams);
  await participation.removeParticipant(actorOf(req), matchId, userId, String(req.id));
  res.status(204).end();
};

export const setAttendance = async (req: Request, res: Response) => {
  const { matchId, userId } = valid(req, 'params', participantParams);
  res.json(await participation.setAttendance(actorOf(req), matchId, userId, valid(req, 'body', attendanceSchema).status, String(req.id)));
};

// ── invitations (private matches are invite-only) ──
export const invite = async (req: Request, res: Response) => {
  const { matchId } = valid(req, 'params', matchIdParams);
  await participation.inviteUser(actorOf(req), matchId, valid(req, 'body', inviteSchema).userId, String(req.id));
  res.status(201).json({ invited: true });
};
