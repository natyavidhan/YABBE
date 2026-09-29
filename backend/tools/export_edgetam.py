"""Export Meta's EdgeTAM (Apache-2.0, https://github.com/facebookresearch/EdgeTAM) to the
ONNX graphs YABBE's roto brush runs with ONNX Runtime (no PyTorch needed at runtime).

Run from an EdgeTAM checkout with PyTorch (CPU is fine) installed:
    cd EdgeTAM && python /path/to/export_edgetam.py OUT_DIR
The Docker build does this in a throwaway stage (see Dockerfile).
Validated against EdgeTAM's own video predictor: mean mask IoU 0.99 on a
hard clip (the fixed-size memory bank pads the first few frames).

Graphs:
  image_encoder      image[1,3,1024,1024] -> vision_feat[4096,1,256], vision_pos[4096,1,256], hi0, hi1
  decoder_single     one mask   (box / several clicks)
  decoder_multi      best of 3  (one click, and every tracked frame)
                     (pix_feat[1,256,64,64], coords[1,P,2] in 1024 px, labels[1,P] int32, hi0, hi1)
                     -> low_res_mask[1,1,256,256], iou, obj_ptr[1,256], object_score[1,1]
  memory_encoder     (vision_feat, low_res_mask, object_score, from_points[1]) -> maskmem[512,1,64], maskmem_pos[512,1,64]
  memory_attention   (curr, curr_pos, memory[7*512+64,1,64], memory_pos) -> pix_feat[1,256,64,64]
Plus constants.npz: maskmem_tpos_enc [7,1,1,64], no_mem_embed [1,1,256].
"""

import sys

import numpy as np
import torch
import torch.nn.functional as F
from torch import nn

import sam2.modeling.sam.transformer as T
from sam2.build_sam import build_sam2_video_predictor


def rope_real(x, freqs, repeat_freqs):
    """apply_rotary_enc_v2 without complex numbers (ONNX has none). ``freqs`` is
    view_as_real(freqs_cis): [..., 2] = (cos, sin)."""
    if x.shape[-2] == 0:
        return x
    B, H, N, C = x.shape
    cos, sin = freqs[..., 0], freqs[..., 1]
    n = cos.shape[0]
    if N == n * repeat_freqs:
        x_rope, x_no = x, None
    else:
        no = N // repeat_freqs - n
        xv = x.view(B, H, repeat_freqs, N // repeat_freqs, C)
        x_rope = xv[..., no:, :].reshape(B, H, -1, C)
        x_no = xv[..., :no, :].reshape(B, H, -1, C)
    if repeat_freqs > 1:
        cos, sin = cos.repeat(repeat_freqs, 1), sin.repeat(repeat_freqs, 1)
    xr = x_rope.float().reshape(*x_rope.shape[:-1], -1, 2)
    a, b = xr[..., 0], xr[..., 1]
    out = torch.stack([a * cos - b * sin, a * sin + b * cos], -1).flatten(3).type_as(x)
    if x_no is not None:
        out = out.view(B, H, repeat_freqs, -1, C)
        out = torch.cat((x_no.view(B, H, repeat_freqs, -1, C), out), dim=3).view(B, H, N, C)
    return out


def _rot(x, cos, sin):
    xr = x.float().reshape(*x.shape[:-1], -1, 2)
    a, b = xr[..., 0], xr[..., 1]
    return torch.stack([a * cos - b * sin, a * sin + b * cos], -1).flatten(3).type_as(x)


def rope_real_v1(xq, xk, freqs_cis, repeat_freqs_k=False):
    """apply_rotary_enc (v1) without complex numbers."""
    cos, sin = freqs_cis[..., 0], freqs_cis[..., 1]
    q = _rot(xq, cos, sin)
    if xk.shape[-2] == 0:
        return q, xk
    if repeat_freqs_k:
        r = xk.shape[-2] // xq.shape[-2]
        cos, sin = cos.repeat(r, 1), sin.repeat(r, 1)
    return q, _rot(xk, cos, sin)


T.apply_rotary_enc_v2 = rope_real

import sam2.modeling.sam.prompt_encoder as PE


def embed_points(self, points, labels, pad):
    """PromptEncoder._embed_points without boolean-mask assignment (which the ONNX
    tracer bakes with a fixed number of points). Same maths."""
    points = points + 0.5
    if pad:
        points = torch.cat([points, torch.zeros((points.shape[0], 1, 2))], dim=1)
        labels = torch.cat([labels.float(), -torch.ones((labels.shape[0], 1))], dim=1)
    pe = self.pe_layer.forward_with_coords(points, self.input_image_size)
    lab = labels.float().unsqueeze(-1)
    pe = torch.where(lab == -1, torch.zeros_like(pe) + self.not_a_point_embed.weight, pe)
    for k in range(4):
        pe = pe + (lab == k).float() * self.point_embeddings[k].weight
    return pe


PE.PromptEncoder._embed_points = embed_points
T.apply_rotary_enc = rope_real_v1

out = sys.argv[1]
torch.set_grad_enabled(False)
m = build_sam2_video_predictor("configs/edgetam.yaml", "checkpoints/edgetam.pt", device="cpu").eval()
for prm in m.parameters():
    prm.requires_grad_(False)
n_rope = 0
for mod in m.modules():
    if isinstance(mod, T.RoPEAttentionv2):
        mod.freqs_cis_q = torch.view_as_real(mod.freqs_cis_q).contiguous()
        mod.freqs_cis_k = torch.view_as_real(mod.freqs_cis_k).contiguous()
        n_rope += 1
    elif isinstance(mod, T.RoPEAttention):
        # sized for the 64x64 feature map up front (it would otherwise rebuild a complex one)
        mod.freqs_cis = torch.view_as_real(mod.compute_cis(end_x=64, end_y=64)).contiguous()
        n_rope += 1
print("RoPE v2 modules patched:", n_rope)
S, P = m.num_maskmem, m.max_obj_ptrs_in_encoder  # 7 memory frames, 16 object pointers
print("num_maskmem", S, "max_obj_ptrs", P, "mem_dim", m.mem_dim, "hidden", m.hidden_dim)


class Encoder(nn.Module):
    def forward(self, image):
        o = m.forward_image(image)
        _, feats, pos, sizes = m._prepare_backbone_features(o)
        hi = [x.permute(1, 2, 0).reshape(1, x.shape[2], *s) for x, s in zip(feats[:-1], sizes[:-1])]
        return feats[-1], pos[-1], hi[0], hi[1]


class Decoder(nn.Module):
    def __init__(self, multimask):
        super().__init__()
        self.multimask = multimask

    def forward(self, pix_feat, coords, labels, hi0, hi1):
        r = m._forward_sam_heads(pix_feat, {"point_coords": coords, "point_labels": labels}, None, [hi0, hi1],
                                 multimask_output=self.multimask)
        _, _, ious, low_res_masks, _, obj_ptr, object_score_logits = r
        return low_res_masks, ious, obj_ptr, object_score_logits


class MemoryEncoder(nn.Module):
    def forward(self, vision_feat, low_res_mask, object_score, from_points):
        high = F.interpolate(low_res_mask, size=(m.image_size, m.image_size), mode="bilinear", align_corners=False)
        # binarise masks that came straight from clicks (as the video predictor does)
        high = torch.where(from_points > 0.5, (high > 0).float() * 64 - 32, high)
        feats, pos = m._encode_new_memory([vision_feat], [(64, 64)], high, object_score, False)
        return feats.permute(1, 0, 2), pos[-1].permute(1, 0, 2)


class MemoryAttention(nn.Module):
    def forward(self, curr, curr_pos, memory, memory_pos):
        o = m.memory_attention(curr=[curr], curr_pos=[curr_pos], memory=memory, memory_pos=memory_pos,
                               num_obj_ptr_tokens=P * 4, num_spatial_mem=S)
        return o.permute(1, 2, 0).reshape(1, 256, 64, 64)


def export(mod, args, name, inputs, outputs, dyn=None):
    torch.onnx.export(mod.eval(), args, f"{out}/{name}.onnx", input_names=inputs, output_names=outputs,
                      dynamic_axes=dyn or {}, opset_version=17, dynamo=False)
    print("exported", name)


img = torch.randn(1, 3, 1024, 1024)
vf, vp, hi0, hi1 = Encoder()(img)
export(Encoder(), (img,), "image_encoder", ["image"], ["vision_feat", "vision_pos", "hi0", "hi1"])
pix = vf.permute(1, 2, 0).reshape(1, 256, 64, 64)
coords = torch.tensor([[[500.0, 400.0], [600.0, 700.0]]])
labels = torch.tensor([[2, 3]], dtype=torch.int32)
dyn = {"coords": {1: "P"}, "labels": {1: "P"}}
for mm, name in ((False, "decoder_single"), (True, "decoder_multi")):
    export(Decoder(mm), (pix, coords, labels, hi0, hi1), name, ["pix_feat", "coords", "labels", "hi0", "hi1"],
           ["low_res_mask", "iou", "obj_ptr", "object_score"], dyn)
low = torch.randn(1, 1, 256, 256)
score = torch.tensor([[1.0]])
export(MemoryEncoder(), (vf, low, score, torch.tensor([1.0])), "memory_encoder",
       ["vision_feat", "low_res_mask", "object_score", "from_points"], ["maskmem", "maskmem_pos"])
M = S * 512 + P * 4
export(MemoryAttention(), (vf, vp, torch.randn(M, 1, 64), torch.randn(M, 1, 64)), "memory_attention",
       ["curr", "curr_pos", "memory", "memory_pos"], ["pix_feat"])
np.savez(f"{out}/constants.npz", maskmem_tpos_enc=m.maskmem_tpos_enc.numpy(), no_mem_embed=m.no_mem_embed.numpy())
print("done")
