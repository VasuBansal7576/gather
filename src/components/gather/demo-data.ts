import type { BookingSummary, Connection } from './types';

/**
 * Deliberately local fixtures for the isolated interface milestone.
 * These are examples only and must be replaced by the host application's contracts.
 */
export const DEMO_BOOKINGS: BookingSummary[] = [
  {
    id: 'booking-clara-01',
    clientName: 'Clara & James',
    eventType: 'Wedding dinner',
    eventDate: 'Sat, 18 Oct',
    eventTime: '6:30 – 11:00 pm',
    guestCount: 84,
    venue: 'The Glasshouse',
    budget: '$14,600',
    status: 'needs-review',
    statusLabel: 'Needs your review',
    nextAction: 'Review the dinner proposal',
    clientInitials: 'CJ',
    clientTone: 'coral',
    detail: {
      receivedAt: 'Today at 9:18 am',
      source: 'Gmail · Clara & James',
      requestSummary:
        'An intimate autumn wedding dinner with a family-style menu, welcome cocktails, and a late-night dessert table.',
      packageName: 'Garden dinner · family style',
      packageDescription: 'Seasonal menu, welcome drinks, and evening service for 84 guests.',
      proposal: {
        id: 'proposal-clara-v2',
        version: 'Version 2 · prepared today',
        total: '$14,600',
        deposit: '$4,380 deposit',
        validUntil: 'Hold valid until 24 Sep',
        lines: [
          { label: 'Dinner package', detail: '84 guests · family style', amount: '$9,240' },
          { label: 'Welcome cocktails', detail: '90 minutes · passed service', amount: '$1,680' },
          { label: 'Dessert table', detail: 'Seasonal fruit & petit fours', amount: '$1,260' },
          { label: 'Staffing & setup', detail: 'Event lead plus four servers', amount: '$2,420' },
        ],
        sources: [
          { title: 'Autumn menus 2025', detail: 'Google Drive · updated 03 Sep', kind: 'drive' },
          { title: 'Saturday availability', detail: 'Google Calendar · 18 Oct', kind: 'calendar' },
          { title: 'Clara & James inquiry', detail: 'Gmail · 3 messages', kind: 'email' },
        ],
      },
      activity: [
        { id: 'clara-inquiry', label: 'Inquiry received', detail: 'Email from Clara & James', timestamp: '9:18 am', kind: 'inquiry' },
        { id: 'clara-sources', label: 'Business context gathered', detail: 'Menu, policies, and availability checked', timestamp: '9:23 am', kind: 'source' },
        { id: 'clara-proposal', label: 'Proposal ready for review', detail: 'Version 2 · $14,600 total', timestamp: '9:25 am', kind: 'proposal' },
      ],
    },
  },
  {
    id: 'booking-maya-02',
    clientName: 'Maya Chen',
    eventType: 'Product launch',
    eventDate: 'Thu, 23 Oct',
    eventTime: '5:00 – 9:30 pm',
    guestCount: 56,
    venue: 'The Glasshouse',
    budget: '$8,900',
    status: 'proposal-ready',
    statusLabel: 'Proposal ready',
    nextAction: 'Approve or edit the offer',
    clientInitials: 'MC',
    clientTone: 'blue',
    detail: {
      receivedAt: 'Yesterday at 4:06 pm',
      source: 'Gmail · Maya Chen',
      requestSummary: 'A bright, relaxed product launch with roaming canapés, a short toast, and a non-alcoholic pairing menu.',
      packageName: 'Launch evening · roaming',
      packageDescription: 'Canapés, pairings, staffing, and a simple welcome moment for 56 guests.',
      proposal: {
        id: 'proposal-maya-v1',
        version: 'Version 1 · prepared yesterday',
        total: '$8,900',
        deposit: '$2,670 deposit',
        validUntil: 'Hold valid until 28 Sep',
        lines: [
          { label: 'Roaming canapés', detail: '56 guests · 6 varieties', amount: '$4,480' },
          { label: 'Pairing menu', detail: 'Zero-proof · 4 pours', amount: '$1,120' },
          { label: 'Toast service', detail: 'Sparkling welcome · 30 minutes', amount: '$620' },
          { label: 'Staffing & setup', detail: 'Event lead plus two servers', amount: '$2,680' },
        ],
        sources: [
          { title: 'Launch packages', detail: 'Google Drive · updated 28 Aug', kind: 'drive' },
          { title: 'Thursday availability', detail: 'Google Calendar · 23 Oct', kind: 'calendar' },
          { title: 'Maya Chen inquiry', detail: 'Gmail · 5 messages', kind: 'email' },
        ],
      },
      activity: [
        { id: 'maya-inquiry', label: 'Inquiry received', detail: 'Email from Maya Chen', timestamp: 'Yesterday', kind: 'inquiry' },
        { id: 'maya-sources', label: 'Business context gathered', detail: 'Launch package and availability checked', timestamp: 'Yesterday', kind: 'source' },
        { id: 'maya-proposal', label: 'Proposal ready for review', detail: 'Version 1 · $8,900 total', timestamp: 'Yesterday', kind: 'proposal' },
      ],
    },
  },
  {
    id: 'booking-owen-03',
    clientName: 'Owen & Co.',
    eventType: 'Team supper',
    eventDate: 'Fri, 31 Oct',
    eventTime: '7:00 – 10:00 pm',
    guestCount: 32,
    venue: 'The Glasshouse',
    budget: '$4,960',
    status: 'hold-pending',
    statusLabel: 'Waiting on connection',
    nextAction: 'Reconnect Calendar to continue',
    clientInitials: 'OC',
    clientTone: 'sage',
    detail: {
      receivedAt: 'Monday at 11:42 am',
      source: 'Gmail · Owen & Co.',
      requestSummary: 'A private team supper with a seasonal three-course menu and a quieter room for conversation.',
      packageName: 'Private supper · three course',
      packageDescription: 'Three courses, non-alcoholic pairings, and a dedicated event lead for 32 guests.',
      proposal: {
        id: 'proposal-owen-v1',
        version: 'Version 1 · prepared Monday',
        total: '$4,960',
        deposit: '$1,488 deposit',
        validUntil: 'Hold valid until 01 Oct',
        lines: [
          { label: 'Three-course supper', detail: '32 guests · seasonal menu', amount: '$3,200' },
          { label: 'Pairing menu', detail: 'Zero-proof · 3 pours', amount: '$640' },
          { label: 'Private room service', detail: 'Dedicated event lead', amount: '$1,120' },
        ],
        sources: [
          { title: 'Private dining policies', detail: 'Google Drive · updated 14 Aug', kind: 'drive' },
          { title: 'Friday availability', detail: 'Google Calendar · reconnect needed', kind: 'calendar' },
          { title: 'Owen & Co. inquiry', detail: 'Gmail · 2 messages', kind: 'email' },
        ],
      },
      activity: [
        { id: 'owen-inquiry', label: 'Inquiry received', detail: 'Email from Owen & Co.', timestamp: 'Mon, 11:42 am', kind: 'inquiry' },
        { id: 'owen-warning', label: 'Availability check paused', detail: 'Calendar connection needs attention', timestamp: 'Mon, 11:47 am', kind: 'warning' },
      ],
    },
  },
];

export const DEMO_CONNECTIONS: Connection[] = [
  {
    provider: 'gmail',
    name: 'Gmail',
    description: 'Read incoming inquiries and keep the conversation in one place.',
    detail: 'Connected · gather@glasshouse.example',
    connected: true,
    lastSynced: 'Synced 4 minutes ago',
  },
  {
    provider: 'drive',
    name: 'Google Drive',
    description: 'Reference menus, packages, policies, and other business context.',
    detail: 'Connected · The Glasshouse / Gather',
    connected: true,
    lastSynced: 'Synced 12 minutes ago',
  },
  {
    provider: 'calendar',
    name: 'Google Calendar',
    description: 'Check availability before an offer is sent or a hold is created.',
    detail: 'Needs attention · permission expired',
    connected: false,
    recommended: true,
  },
];
