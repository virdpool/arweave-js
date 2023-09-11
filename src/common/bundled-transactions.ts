import Transaction from "./lib/transaction";
import { hash, intToBuffer, rebaseMark, Chunk, Proof } from "./lib/merkle";
import { concatBuffers } from "./lib/utils";

const chunk_size_bn = BigInt(256 * 1024);
export interface TreeNode {
  tx: Transaction | null;
  offset_bn: bigint;
  dense_offset_bn: bigint;
  size_bn: bigint;
  dense_size_bn: bigint;
  data_root: Uint8Array;
  proof: Uint8Array | null;
  proof_part: Uint8Array | null;
  child_list: TreeNode[] | null;
}

export async function createTree(
  txList: Transaction[],
  offset_bn: bigint,
  dense_offset_bn: bigint
): Promise<TreeNode> {
  if (txList.length == 1) {
    let tx = txList[0];
    let size_bn = BigInt(tx.data_size);
    let dense_size_bn = size_bn;
    let rem = size_bn % chunk_size_bn;
    if (rem != 0n) {
      size_bn = size_bn - rem + chunk_size_bn;
    }
    if (!tx.chunks) {
      throw new Error("!tx.chunks");
    }
    return {
      tx: tx,
      offset_bn: offset_bn,
      dense_offset_bn: dense_offset_bn,
      size_bn: size_bn,
      dense_size_bn: dense_size_bn,
      data_root: tx.chunks.data_root,
      proof: null,
      proof_part: null,
      child_list: null,
    };
  } else {
    // Idea: If you want to append you should only change right-most subtree
    let splitIdx = 2 ** Math.floor(Math.log2(txList.length - 1));
    let txList1 = txList.slice(0, splitIdx);
    let txList2 = txList.slice(splitIdx);
    let base_offset_bn = offset_bn;
    let base_dense_offset_bn = dense_offset_bn;

    let subTree1 = await createTree(txList1, offset_bn, dense_offset_bn);
    offset_bn += subTree1.size_bn;
    dense_offset_bn += subTree1.dense_size_bn;
    let subTree2 = await createTree(txList2, offset_bn, dense_offset_bn);
    offset_bn += subTree2.size_bn;
    dense_offset_bn += subTree2.dense_size_bn;

    // hash([hash(L), hash(R), hash(note_to_binary(Note))])
    let note_buf = intToBuffer(parseInt(subTree1.size_bn.toString()));
    let data_root = await hash([
      await hash(subTree1.data_root),
      await hash(subTree2.data_root),
      await hash(note_buf),
    ]);
    let proof_part = concatBuffers([
      rebaseMark,
      subTree1.data_root,
      subTree2.data_root,
      note_buf,
    ]);
    return {
      tx: null,
      offset_bn: base_offset_bn,
      dense_offset_bn: base_dense_offset_bn,
      size_bn: subTree1.size_bn + subTree2.size_bn,
      dense_size_bn: subTree1.dense_size_bn + subTree2.dense_size_bn,
      data_root: data_root,
      proof: null,
      proof_part: proof_part,
      child_list: [subTree1, subTree2],
    };
  }
}

// will mutate proofs in child tx'es
export function fillProof(tree: TreeNode, proof_prefix: Uint8Array) {
  // << 0:(?HASH_SIZE*8), L:?HASH_SIZE/binary, R:?HASH_SIZE/binary, Note:(?NOTE_SIZE*8), Rest/binary >>,
  if (tree.child_list) {
    let branch1 = tree.child_list[0];
    let branch2 = tree.child_list[1];
    if (!tree.proof_part) {
      throw new Error("!tree.proof_part");
    }
    let new_proof_prefix = concatBuffers([proof_prefix, tree.proof_part]);
    fillProof(branch1, new_proof_prefix);
    fillProof(branch2, new_proof_prefix);
  } else {
    tree.proof = proof_prefix;
  }
}

export function updateChunkProof(tree: TreeNode, data_root: Uint8Array) {
  // << 0:(?HASH_SIZE*8), L:?HASH_SIZE/binary, R:?HASH_SIZE/binary, Note:(?NOTE_SIZE*8), Rest/binary >>,
  if (tree.child_list) {
    updateChunkProof(tree.child_list[0], data_root);
    updateChunkProof(tree.child_list[1], data_root);
  } else {
    if (!tree.tx) {
      throw new Error("!tree.tx");
    }
    if (!tree.tx.chunks) {
      throw new Error("!tree.tx.chunks");
    }
    if (!tree.proof) {
      throw new Error("!tree.proof");
    }
    tree.tx.chunks.data_root = data_root;
    var list = tree.tx.chunks.proofs;
    for (var i = 0, len = list.length; i < len; i++) {
      let leaf = list[i];
      let new_proof = new Uint8Array(tree.proof.length + leaf.proof.length);
      new_proof.set(tree.proof, 0);
      new_proof.set(leaf.proof, tree.proof.length);
      leaf.proof = new_proof;
      leaf.offset = parseInt((BigInt(leaf.offset) + tree.offset_bn).toString());

      let chunk = tree.tx.chunks.chunks[i];
      chunk.minByteRange = parseInt(
        (BigInt(chunk.minByteRange) + tree.dense_offset_bn).toString()
      );
      chunk.maxByteRange = parseInt(
        (BigInt(chunk.maxByteRange) + tree.dense_offset_bn).toString()
      );
    }
    tree.tx.offset = parseInt(tree.offset_bn.toString());
    tree.tx.dense_offset = parseInt(tree.dense_offset_bn.toString());
  }
}

export function collectChunkAndProofList(
  tree: TreeNode,
  chunkList: Chunk[],
  proofList: Proof[]
) {
  if (tree.child_list) {
    collectChunkAndProofList(tree.child_list[0], chunkList, proofList);
    collectChunkAndProofList(tree.child_list[1], chunkList, proofList);
  } else {
    if (!tree.tx) {
      throw new Error("!tree.tx");
    }
    if (!tree.tx.chunks) {
      throw new Error("!tree.tx.chunks");
    }
    var loc_chunk_list = tree.tx.chunks.chunks;
    var loc_proof_list = tree.tx.chunks.proofs;
    for (var i = 0, len = loc_chunk_list.length; i < len; i++) {
      chunkList.push(loc_chunk_list[i]);
      proofList.push(loc_proof_list[i]);
    }
  }
}
