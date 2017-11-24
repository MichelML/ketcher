/****************************************************************************
 * Copyright 2017 EPAM Systems
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 ***************************************************************************/

import Vec2 from '../../util/vec2';
import Pile from '../../util/pile';
import Struct from '../../chem/struct';

import op from '../shared/op';
import Action from '../shared/action';

import { atomGetDegree, atomGetNeighbors, getRelSgroupsBySelection } from './utils';
import { removeSgroupIfNeeded, removeAtomFromSgroupIfNeeded, fromSgroupDeletion } from './sgroup';
import { fromRGroupFragment, fromUpdateIfThen } from './rgroup';

export function fromMultipleMove(restruct, lists, d) {
	d = new Vec2(d);

	const action = new Action();
	const struct = restruct.molecule;
	const loops = new Pile();
	const atomsToInvalidate = new Pile();

	if (lists.atoms) {
		const atomSet = new Pile(lists.atoms);
		const bondlist = [];

		restruct.bonds.forEach((bond, bid) => {
			if (atomSet.has(bond.b.begin) && atomSet.has(bond.b.end)) {
				bondlist.push(bid);
				// add all adjacent loops
				// those that are not completely inside the structure will get redrawn anyway
				['hb1', 'hb2'].forEach(hb => {
					const loop = struct.halfBonds.get(bond.b[hb]).loop;
					if (loop >= 0)
						loops.add(loop);
				});
				return;
			}

			if (atomSet.has(bond.b.begin)) {
				atomsToInvalidate.add(bond.b.begin);
				return;
			}

			if (atomSet.has(bond.b.end))
				atomsToInvalidate.add(bond.b.end);
		});

		bondlist.forEach(bond => action.addOp(new op.BondMove(bond, d)));

		loops.forEach(loopId => {
			if (restruct.reloops.get(loopId) && restruct.reloops.get(loopId).visel) // hack
				action.addOp(new op.LoopMove(loopId, d));
		});

		lists.atoms.forEach(aid => action.addOp(new op.AtomMove(aid, d, !atomsToInvalidate.has(aid))));

		if (lists.sgroupData.length === 0) {
			const sgroups = getRelSgroupsBySelection(restruct, lists.atoms);
			sgroups.forEach(sg => {
				action.addOp(new op.SGroupDataMove(sg.id, d));
			});
		}
	}

	if (lists.rxnArrows)
		lists.rxnArrows.forEach(rxnArrow => action.addOp(new op.RxnArrowMove(rxnArrow, d, true)));

	if (lists.rxnPluses)
		lists.rxnPluses.forEach(rxnPulse => action.addOp(new op.RxnPlusMove(rxnPulse, d, true)));

	if (lists.sgroupData)
		lists.sgroupData.forEach(sgData => action.addOp(new op.SGroupDataMove(sgData, d)));

	if (lists.chiralFlags)
		lists.chiralFlags.forEach(() => action.addOp(new op.ChiralFlagMove(d)));

	return action.perform(restruct);
}

/**
 * @param restruct { ReStruct }
 * @param aid { number }
 * @param frid { number }
 * @param newfrid { number }
 * @returns { Action }
 */
function processAtom(restruct, aid, frid, newfrid) {
	const action = new Action();
	const queue = [aid];

	while (queue.length > 0) {
		action.addOp(new op.AtomAttr(aid, 'fragment', newfrid).perform(restruct));

		atomGetNeighbors(restruct, aid).forEach(nei => {
			if (restruct.molecule.atoms.get(nei.aid).fragment === frid)
				queue.push(restruct, nei.aid, frid, newfrid);
		});

		queue.shift();
	}

	return action;
}

export function FromFragmentSplit(restruct, frid) { // TODO [RB] the thing is too tricky :) need something else in future
	var action = new Action();
	var rgid = Struct.RGroup.findRGroupByFragment(restruct.molecule.rgroups, frid);

	restruct.molecule.atoms.forEach((atom, aid) => {
		if (atom.fragment === frid) {
			const newfrid = action.addOp(new op.FragmentAdd().perform(restruct)).frid;

			action.mergeWith(processAtom(restruct, aid, frid, newfrid));

			if (rgid)
				action.mergeWith(fromRGroupFragment(restruct, rgid, newfrid));
		}
	});

	if (frid !== -1) {
		action.mergeWith(fromRGroupFragment(restruct, 0, frid));
		action.addOp(new op.FragmentDelete(frid).perform(restruct));
		action.mergeWith(fromUpdateIfThen(restruct, 0, rgid));
	}

	return action;
}

export function fromFragmentDeletion(restruct, selection) { // eslint-disable-line max-statements
	console.assert(!!selection);
	var action = new Action();
	var atomsToRemove = [];
	var frids = [];
	selection = {               // TODO: refactor me
		atoms: selection.atoms || [],
		bonds: selection.bonds || [],
		rxnPluses: selection.rxnPluses || [],
		rxnArrows: selection.rxnArrows || [],
		sgroupData: selection.sgroupData || [],
		chiralFlags: selection.chiralFlags || []
	};

	var actionRemoveDataSGroups = new Action();
	selection.sgroupData.forEach(function (id) {
		actionRemoveDataSGroups.mergeWith(fromSgroupDeletion(restruct, id));
	}, this);

	selection.atoms.forEach(function (aid) {
		atomGetNeighbors(restruct, aid).forEach(function (nei) {
			if (selection.bonds.indexOf(nei.bid) == -1)
				selection.bonds = selection.bonds.concat([nei.bid]);
		}, this);
	}, this);

	selection.bonds.forEach(function (bid) {
		action.addOp(new op.BondDelete(bid));

		var bond = restruct.molecule.bonds.get(bid);
		var frid = restruct.molecule.atoms.get(bond.begin).fragment;
		if (frids.indexOf(frid) < 0)
			frids.push(frid);

		if (selection.atoms.indexOf(bond.begin) == -1 && atomGetDegree(restruct, bond.begin) == 1) {
			if (removeAtomFromSgroupIfNeeded(action, restruct, bond.begin))
				atomsToRemove.push(bond.begin);

			action.addOp(new op.AtomDelete(bond.begin));
		}
		if (selection.atoms.indexOf(bond.end) == -1 && atomGetDegree(restruct, bond.end) == 1) {
			if (removeAtomFromSgroupIfNeeded(action, restruct, bond.end))
				atomsToRemove.push(bond.end);

			action.addOp(new op.AtomDelete(bond.end));
		}
	}, this);


	selection.atoms.forEach(function (aid) {
		var frid3 = restruct.molecule.atoms.get(aid).fragment;
		if (frids.indexOf(frid3) < 0)
			frids.push(frid3);

		if (removeAtomFromSgroupIfNeeded(action, restruct, aid))
			atomsToRemove.push(aid);

		action.addOp(new op.AtomDelete(aid));
	}, this);

	removeSgroupIfNeeded(action, restruct, atomsToRemove);

	selection.rxnArrows.forEach(function (id) {
		action.addOp(new op.RxnArrowDelete(id));
	}, this);

	selection.rxnPluses.forEach(function (id) {
		action.addOp(new op.RxnPlusDelete(id));
	}, this);

	selection.chiralFlags.forEach(function (id) {
		action.addOp(new op.ChiralFlagDelete(id));
	}, this);

	action = action.perform(restruct);

	while (frids.length > 0)
		action.mergeWith(new FromFragmentSplit(restruct, frids.pop()));

	action.mergeWith(actionRemoveDataSGroups);

	return action;
}
