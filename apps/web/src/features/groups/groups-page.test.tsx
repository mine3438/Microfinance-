import { type Branch, type Group, type GroupMember } from '@mfi/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError } from '../../shared/api/client.js';

/**
 * Groups, membership, and the borrower's view of both.
 *
 * What these tests protect, beyond the ordinary list-and-form behaviour:
 *
 * **No group can borrow.** There is no control anywhere in this feature that
 * starts a loan, and one test asserts that against the rendered text rather
 * than against a route table, because the failure mode is somebody adding a
 * button, not somebody adding a route.
 *
 * **Membership is a period, not a flag.** A departure is recorded with a date
 * and the row stays; the roster can be read as it stood on a past date. A
 * screen that only knew today would make an older record unreadable.
 *
 * **No money.** A group holds no balance and a member holds no share of one, so
 * nothing here formats an amount.
 */

const list = vi.fn<() => Promise<Group[]>>();
const get = vi.fn<() => Promise<Group>>();
const create = vi.fn<(request: unknown) => Promise<Group>>();
const update = vi.fn<(...args: unknown[]) => Promise<Group>>();
const members = vi.fn<(...args: unknown[]) => Promise<GroupMember[]>>();
const addMember = vi.fn<(...args: unknown[]) => Promise<GroupMember>>();
const endMembership = vi.fn<(...args: unknown[]) => Promise<GroupMember>>();
const forClient = vi.fn<(...args: unknown[]) => Promise<GroupMember[]>>();
const listBranches = vi.fn<() => Promise<Branch[]>>();
const getClient = vi.fn<() => Promise<{ id: string; fullName: string }>>();

vi.mock('../../shared/api/endpoints.js', () => ({
  groups: {
    list: (): Promise<Group[]> => list(),
    get: (): Promise<Group> => get(),
    create: (request: unknown): Promise<Group> => create(request),
    update: (...args: unknown[]): Promise<Group> => update(...args),
    members: (...args: unknown[]): Promise<GroupMember[]> => members(...args),
    addMember: (...args: unknown[]): Promise<GroupMember> => addMember(...args),
    endMembership: (...args: unknown[]): Promise<GroupMember> => endMembership(...args),
    forClient: (...args: unknown[]): Promise<GroupMember[]> => forClient(...args),
  },
  branches: { list: (): Promise<Branch[]> => listBranches() },
  clients: { get: (): Promise<{ id: string; fullName: string }> => getClient() },
}));

let permissions = new Set<string>(['client.read', 'client.create', 'client.update']);

vi.mock('../auth/session.js', () => ({
  useSession: (): { can: (permission: string) => boolean; user: unknown } => ({
    can: (permission: string) => permissions.has(permission),
    user: { branch: null, fullName: 'Asha Mwakalinga' },
  }),
}));

// The picker is a shared component with its own suite; stubbing it keeps these
// tests about the group screens rather than about borrower search.
vi.mock('../../shared/ui/client-picker.js', () => ({
  ClientPicker: ({
    id,
    label,
    onChange,
  }: {
    id: string;
    label: string;
    onChange: (value: string) => void;
  }) => (
    <label htmlFor={id}>
      {label}
      <input
        id={id}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </label>
  ),
}));

const { GroupsPage } = await import('./groups-page.js');
const { GroupPage } = await import('./group-page.js');
const { ClientGroupsPage } = await import('./client-groups-page.js');

const GROUP_ID = '019fef66-0000-7000-8000-0000000000g1';
const CLIENT_ID = '019fef66-0000-7000-8000-0000000000c1';
const BRANCH_ID = '019fef66-0000-7000-8000-0000000000b1';

const group = (overrides: Partial<Group> = {}): Group => ({
  id: GROUP_ID,
  code: 'GRP-001',
  name: 'Umoja Women',
  branchId: BRANCH_ID,
  branchName: 'Head Office',
  formedOn: '2026-01-15',
  status: 'active',
  currentMemberCount: 2,
  createdAt: '2026-01-15T08:00:00.000Z',
  ...overrides,
});

const member = (overrides: Partial<GroupMember> = {}): GroupMember => ({
  id: '019fef66-0000-7000-8000-0000000000m1',
  groupId: GROUP_ID,
  clientId: CLIENT_ID,
  clientName: 'Neema Kimaro',
  clientCode: 'CLT-0001',
  joinedOn: '2026-01-15',
  leftOn: null,
  ...overrides,
});

const BRANCHES: Branch[] = [
  {
    id: BRANCH_ID,
    code: 'HO',
    name: 'Head Office',
    isHeadOffice: true,
    status: 'active',
    districtCode: 'tz_arusha__karatu',
    districtName: 'Karatu DC',
  },
];

function renderWith(element: React.ReactNode, path = '/groups', route = '/groups'): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={route} element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  permissions = new Set(['client.read', 'client.create', 'client.update']);
  list.mockResolvedValue([group()]);
  get.mockResolvedValue(group());
  create.mockResolvedValue(group());
  update.mockResolvedValue(group({ name: 'Umoja Women Renamed' }));
  members.mockResolvedValue([member()]);
  addMember.mockResolvedValue(member());
  endMembership.mockResolvedValue(member({ leftOn: '2026-06-30' }));
  forClient.mockResolvedValue([member()]);
  listBranches.mockResolvedValue(BRANCHES);
  getClient.mockResolvedValue({ id: CLIENT_ID, fullName: 'Neema Kimaro' });
});

/**
 * Narrow away the `null` that DOM traversal returns.
 *
 * `closest()` is typed as possibly null, but a test that reached this line has
 * already found the element it started from. Throwing here fails the test with
 * a readable message instead of an assertion the lint rules forbid.
 */
function must<T>(value: T | null): T {
  if (value === null) {
    throw new Error('Expected an element, and the DOM had none.');
  }
  return value;
}

describe('the group list', () => {
  it('shows each group with its branch and member count', async () => {
    renderWith(<GroupsPage />);

    const row = (await screen.findByRole('link', { name: 'Umoja Women' })).closest('tr');
    expect(row).not.toBeNull();
    expect(within(must(row)).getByText('GRP-001')).toBeInTheDocument();
    expect(within(must(row)).getByText('Head Office')).toBeInTheDocument();
    expect(within(must(row)).getByText('2')).toBeInTheDocument();
  });

  it('says so when there are none, rather than showing a blank table', async () => {
    list.mockResolvedValue([]);
    renderWith(<GroupsPage />);

    expect(await screen.findByText('No groups yet')).toBeInTheDocument();
  });

  it('shows the failure rather than an empty list when the request fails', async () => {
    list.mockRejectedValue(new ApiRequestError('internal_error', 'Something went wrong.', 500));
    renderWith(<GroupsPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
    expect(screen.queryByText('No groups yet')).not.toBeInTheDocument();
  });

  it('offers no way to form a group without the permission', async () => {
    permissions = new Set(['client.read']);
    renderWith(<GroupsPage />);

    await screen.findByRole('link', { name: 'Umoja Women' });
    expect(screen.queryByRole('button', { name: 'Form a group' })).not.toBeInTheDocument();
  });
});

describe('forming a group', () => {
  it('sends the code, name, branch and formation date', async () => {
    renderWith(<GroupsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Form a group' }));
    await userEvent.type(screen.getByLabelText('Group code'), 'GRP-002');
    await userEvent.type(screen.getByLabelText('Group name'), 'Tumaini Traders');
    await userEvent.selectOptions(await screen.findByLabelText('Branch'), BRANCH_ID);
    await userEvent.click(screen.getByRole('button', { name: 'Form the group' }));

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'GRP-002',
        name: 'Tumaini Traders',
        branchId: BRANCH_ID,
      }),
    );
  });

  it('shows a field error against the field the server named', async () => {
    create.mockRejectedValue(
      new ApiRequestError('validation_failed', 'That group cannot be created as entered.', 422, [
        { path: ['code'], message: 'That code is already in use.' },
      ]),
    );

    renderWith(<GroupsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Form a group' }));
    await userEvent.type(screen.getByLabelText('Group code'), 'GRP-001');
    await userEvent.type(screen.getByLabelText('Group name'), 'Duplicate');
    await userEvent.click(screen.getByRole('button', { name: 'Form the group' }));

    expect(await screen.findByText('That code is already in use.')).toBeInTheDocument();
    expect(screen.getByLabelText('Group code')).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('the group page', () => {
  const renderGroup = (): void => {
    renderWith(<GroupPage />, `/groups/${GROUP_ID}`, '/groups/:id');
  };

  it('shows the group and its roster', async () => {
    renderGroup();

    expect(await screen.findByRole('heading', { name: 'Umoja Women' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Neema Kimaro' })).toBeInTheDocument();
    expect(screen.getByText('Still a member')).toBeInTheDocument();
  });

  it('links a member to that borrower’s own groups', async () => {
    renderGroup();

    expect(await screen.findByRole('link', { name: 'Neema Kimaro' })).toHaveAttribute(
      'href',
      `/clients/${CLIENT_ID}/groups`,
    );
  });

  it('reads the roster as it stood on a date when one is given', async () => {
    renderGroup();
    await screen.findByRole('link', { name: 'Neema Kimaro' });

    await userEvent.type(screen.getByLabelText('Membership as at'), '2026-03-01');

    await vi.waitFor(() => {
      expect(members).toHaveBeenCalledWith(GROUP_ID, '2026-03-01');
    });
  });

  it('adds a member with the date they joined', async () => {
    renderGroup();

    await userEvent.click(await screen.findByRole('button', { name: 'Add a member' }));
    await userEvent.type(screen.getByLabelText('Borrower'), CLIENT_ID);
    await userEvent.click(screen.getByRole('button', { name: 'Add to the group' }));

    expect(addMember).toHaveBeenCalledWith(
      GROUP_ID,
      expect.objectContaining({ clientId: CLIENT_ID }),
    );
  });

  /**
   * A departure closes the interval; it never deletes the membership.
   *
   * The control says "Record departure" rather than "Remove", and the call is a
   * departure with a date. If this ever became a delete, the periods that make
   * an older record legible would go with it.
   */
  it('records a departure with a date rather than removing the member', async () => {
    renderGroup();

    await userEvent.click(await screen.findByRole('button', { name: 'Record departure' }));
    await userEvent.click(screen.getByRole('button', { name: 'Record the departure' }));

    expect(endMembership).toHaveBeenCalledWith(
      GROUP_ID,
      CLIENT_ID,
      expect.objectContaining({ leftOn: expect.any(String) as string }),
    );
    expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
  });

  it('keeps a departed member on the roster, with the date they left', async () => {
    members.mockResolvedValue([member({ leftOn: '2026-06-30' })]);
    renderGroup();

    expect(await screen.findByRole('link', { name: 'Neema Kimaro' })).toBeInTheDocument();
    expect(screen.getByText('30 Jun 2026')).toBeInTheDocument();
  });

  it('offers no membership changes to someone who may only read', async () => {
    permissions = new Set(['client.read']);
    renderGroup();

    await screen.findByRole('heading', { name: 'Umoja Women' });
    expect(screen.queryByRole('button', { name: 'Add a member' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record departure' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit group' })).not.toBeInTheDocument();
  });

  it('renames a group without touching anything else about it', async () => {
    renderGroup();

    await userEvent.click(await screen.findByRole('button', { name: 'Edit group' }));
    const name = screen.getByLabelText('Group name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Umoja Women Renamed');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(update).toHaveBeenCalledWith(GROUP_ID, {
      name: 'Umoja Women Renamed',
      status: 'active',
    });
  });
});

describe('a borrower’s groups', () => {
  const renderClientGroups = (): void => {
    renderWith(<ClientGroupsPage />, `/clients/${CLIENT_ID}/groups`, '/clients/:id/groups');
  };

  it('lists the groups they belong to, named', async () => {
    renderClientGroups();

    expect(await screen.findByRole('link', { name: 'Umoja Women' })).toHaveAttribute(
      'href',
      `/groups/${GROUP_ID}`,
    );
  });

  it('says so when they belong to none', async () => {
    forClient.mockResolvedValue([]);
    renderClientGroups();

    expect(await screen.findByText('This borrower is not in any group')).toBeInTheDocument();
  });

  it('reads memberships as at a date when one is given', async () => {
    renderClientGroups();
    await screen.findByRole('link', { name: 'Umoja Women' });

    await userEvent.type(screen.getByLabelText('Membership as at'), '2026-03-01');

    await vi.waitFor(() => {
      expect(forClient).toHaveBeenCalledWith(CLIENT_ID, '2026-03-01');
    });
  });
});

/**
 * The regression that matters most in this feature.
 *
 * GROUP-05 is unresolved: every MSP2 exposure query reaches a borrower's
 * sector, gender, age and district through `loans.client_id`, and a group has
 * none of them, so a group loan would drop out of MSP2-03, 09 and 10 without
 * saying so. Groups exist here as an administrative record and nothing more.
 */
describe('group lending stays unavailable', () => {
  const lendingWords =
    /group loan|lend to|apply for a loan|disburse|repayment|balance|outstanding/i;

  it('offers no lending control on the group list', async () => {
    renderWith(<GroupsPage />);
    await screen.findByRole('link', { name: 'Umoja Women' });

    for (const button of screen.getAllByRole('button')) {
      expect(button.textContent).not.toMatch(lendingWords);
    }
    expect(screen.getByText(/Group lending is not available in this system/)).toBeInTheDocument();
  });

  it('offers no lending control on the group page', async () => {
    renderWith(<GroupPage />, `/groups/${GROUP_ID}`, '/groups/:id');
    // Waits for the roster, not just the heading: the member rows carry the
    // only links on this page, so asserting before they arrive would pass
    // against a screen that had not rendered them yet.
    await screen.findByRole('link', { name: 'Neema Kimaro' });

    for (const button of screen.getAllByRole('button')) {
      expect(button.textContent).not.toMatch(lendingWords);
    }
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href')).not.toMatch(/loan/i);
    }
  });

  /**
   * A group has no money on it. Not "shows zero" — shows nothing, because a
   * member-level balance is a figure no rule in this system produces.
   */
  it('shows no monetary figure anywhere on a group', async () => {
    renderWith(<GroupPage />, `/groups/${GROUP_ID}`, '/groups/:id');
    await screen.findByRole('link', { name: 'Neema Kimaro' });

    expect(document.body.textContent).not.toMatch(/TZS/);
  });
});
