// Products: the Projects list (products and their requests, with deletion)
// and the Requirements page (every agreed version of a product's
// requirements). Data comes from /api/state and /api/products/:id.

import { dateTime, duration, h, icon, mount } from './dom.js';
import { statusLabel, verificationBadge } from './views.js';

/** The product the dashboard currently shows, if any. */
export function currentProductId(state, detail) {
  return detail ? detail.workflow.productId : null;
}

export function mountProjects(actions) {
  mount(
    'view',
    h(
      'section',
      { className: 'panel' },
      h(
        'div',
        { className: 'view-head' },
        h('div', null, h('h1', null, 'Projects'), h('p', { className: 'muted' }, 'Every product, with the requests (iterations) that built and changed it. Deleting a product removes its requests, activity, statistics and files for good.')),
        h('button', { id: 'delete-all', type: 'button', className: 'btn btn-sm btn-danger', onclick: () => actions.deleteProduct(null) }, 'Delete all products'),
      ),
      h('div', { id: 'products', className: 'product-list' }),
    ),
  );
}

export function renderProjects(state, ui, actions) {
  const busy = ui.deleting !== null;
  document.getElementById('delete-all').disabled = busy || !state.products.length;
  if (!state.products.length) {
    mount('products', h('p', { className: 'empty' }, 'No products yet. Start one from Home.'));
    return;
  }
  const byProduct = {};
  state.workflows.forEach((wf) => (byProduct[wf.productId] = (byProduct[wf.productId] || []).concat(wf)));
  const running = state.workflows.find((w) => w.id === state.activeWorkflowId && w.status === 'running');

  mount(
    'products',
    state.products.map((product) =>
      h(
        'article',
        { className: 'product-card', 'aria-label': product.title },
        h(
          'div',
          { className: 'product-head' },
          h(
            'div',
            { style: 'min-width:0' },
            h('h2', null, product.title),
            h(
              'p',
              { className: 'muted small' },
              `${product.iterations} request${product.iterations === 1 ? '' : 's'} · ${product.versions ? `requirements v${product.versions}` : 'no agreed requirements'} · last change ${dateTime(product.updatedAt)}`,
            ),
            product.current
              ? h(
                  'p',
                  { className: 'product-current' },
                  h('span', { className: 'muted small' }, `Current version v${product.current.version}:`),
                  h('span', { className: 'status-pill', dataset: { status: product.current.status } }, statusLabel(state, product.current.status)),
                  verificationBadge(product.current),
                )
              : null,
          ),
          h(
            'div',
            { className: 'product-actions' },
            h('button', { type: 'button', className: 'btn btn-sm', onclick: () => actions.openRequirements(product.id) }, 'Requirements'),
            product.versions
              ? h('button', { type: 'button', className: 'btn btn-sm', onclick: () => actions.startChange(product.id) }, 'Request a change')
              : null,
            h(
              'button',
              {
                type: 'button',
                className: 'btn btn-sm btn-danger',
                disabled: busy || Boolean(running && running.productId === product.id),
                title: running && running.productId === product.id ? 'A request of this product is running' : null,
                onclick: () => actions.deleteProduct(product.id),
              },
              ui.deleting === product.id ? 'Deleting…' : 'Delete',
            ),
          ),
        ),
        h(
          'ol',
          { className: 'project-list' },
          (byProduct[product.id] || [])
            .slice()
            .reverse()
            .map((wf) =>
              h(
                'li',
                null,
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'project-item',
                    'aria-current': wf.id === ui.selectedId ? 'true' : 'false',
                    onclick: () => {
                      actions.select(wf.id);
                      location.hash = '#/';
                    },
                  },
                  h(
                    'span',
                    null,
                    h('span', { className: 'muted small', style: 'display:block' }, wf.id === product.id ? 'New product' : 'Change request'),
                    h('span', { style: 'display:block' }, `“${wf.requestText}”`),
                    h('span', { className: 'muted small', style: 'display:block' }, `${dateTime(wf.createdAt)}${wf.finishedAt ? ` · took ${duration(new Date(wf.finishedAt) - new Date(wf.createdAt))}` : ''}`),
                  ),
                  h('span', { className: 'badges' }, h('span', { className: 'status-pill', dataset: { status: wf.status } }, statusLabel(state, wf.status)), verificationBadge(wf)),
                ),
              ),
            ),
        ),
      ),
    ),
  );
}

export function mountRequirements(state, ui, actions) {
  mount(
    'view',
    h(
      'section',
      { className: 'panel' },
      h(
        'div',
        { className: 'view-head' },
        h('div', null, h('h1', null, 'Requirements'), h('p', { className: 'muted' }, 'The requirements and acceptance criteria agreed by the PO, version by version. Each change request that the PO analysed adds a version.')),
        h('label', { className: 'product-picker' }, h('span', { className: 'muted small' }, 'Product'), h('select', { id: 'requirements-product', onchange: (e) => actions.openRequirements(e.target.value || null) })),
      ),
      h('div', { id: 'requirements' }),
    ),
  );
}

export function renderRequirements(state, ui, actions) {
  const select = document.getElementById('requirements-product');
  if (!select) return;
  const current = ui.requirementsProductId;
  mount(
    select,
    state.products.length ? null : h('option', { value: '' }, 'No products yet'),
    state.products.map((p) => h('option', { value: p.id, selected: p.id === current }, p.title)),
  );

  const data = ui.requirements;
  if (!current || !data) {
    mount('requirements', h('p', { className: 'empty' }, state.products.length ? 'Loading…' : 'No requirements yet. Start a product from Home.'));
    return;
  }
  const versions = data.iterations.slice().reverse();
  mount(
    'requirements',
    data.product.versions
      ? h(
          'p',
          { className: 'muted small' },
          `Current: version ${data.product.versions} of "${data.product.title}". `,
          h('button', { type: 'button', className: 'link-button', onclick: () => actions.startChange(current) }, 'Request a change'),
        )
      : null,
    h(
      'ol',
      { className: 'version-list' },
      versions.map((it) =>
        h(
          'li',
          { className: 'version' },
          h(
            'div',
            { className: 'version-head' },
            h('strong', null, it.spec ? `Version ${it.spec.version ?? '?'}` : 'No new version'),
            h('span', { className: 'status-pill', dataset: { status: it.status } }, statusLabel(state, it.status)),
            h('span', { className: 'muted small' }, dateTime(it.createdAt)),
          ),
          h('p', null, h('span', { className: 'muted' }, it.change ? `Change request (on version ${it.baseVersion}): ` : 'Original request: '), `“${it.requestText}”`),
          it.spec
            ? [
                it.spec.changes ? h('div', null, h('p', { className: 'muted small' }, 'Changes'), it.spec.changes.length ? h('ul', null, it.spec.changes.map((c) => h('li', null, c))) : h('p', { className: 'muted small' }, 'The PO listed no changes.')) : null,
                h('p', { className: 'muted small' }, 'Requirements'),
                h('ol', { className: 'plan' }, it.spec.requirements.map((r, i) => h('li', null, h('span', { className: 'num' }, i + 1), h('span', null, r)))),
                h('p', { className: 'muted small' }, 'Acceptance criteria'),
                h('ol', { className: 'plan' }, it.spec.acceptanceCriteria.map((c) => h('li', null, h('span', { className: 'num ac' }, c.id), h('span', null, c.description)))),
              ]
            : h('p', { className: 'muted small' }, 'The PO did not agree requirements for this request (see its conversation).'),
          h('button', { type: 'button', className: 'link-button small', onclick: () => { actions.select(it.workflowId); location.hash = '#/'; } }, 'Open its conversation ', icon('chevron')),
        ),
      ),
    ),
  );
}
