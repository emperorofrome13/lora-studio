"""Default test prompts. All prompts are UGC-style influencer scenes."""

from __future__ import annotations

DEFAULT_PROMPTS = [
    {
        "id": "p1",
        "label": "UGC 1 · Rooftop café",
        "text": (
            "Candid UGC-style iPhone photo of a stylish 24-year-old female influencer sitting "
            "at a rooftop café table in a sunlit European city, wearing a fitted floral midi "
            "dress with a sweetheart neckline and thin straps, delicate gold jewelry, loose "
            "beachy waves, natural freckles, soft glossy makeup. She laughs mid-conversation "
            "while holding an iced latte, phone in her other hand, croissant and sunglasses on "
            "the marble table. Golden-hour sunlight rakes across the scene from the left, warm "
            "rim light in her hair, soft shadows, realistic skin texture with visible pores and "
            "fine facial hair, slight iPhone lens vignette, shallow depth of field, blurred café "
            "umbrellas and terracotta rooftops behind her, authentic social-media influencer "
            "snapshot, unposed, highly detailed, photorealistic, 35mm lifestyle photography."
        ),
    },
    {
        "id": "p2",
        "label": "UGC 2 · Autumn street style",
        "text": (
            "Full-body candid UGC-style photo of a young woman influencer walking through a "
            "tree-lined city street in early autumn, wearing a pleated champagne satin mini "
            "skirt, oversized cream cable-knit sweater slipping off one shoulder, black "
            "knee-high leather boots, layered gold necklaces, a small structured shoulder bag, "
            "tousled auburn hair with curtain bangs, natural makeup, confident mid-stride pose. "
            "Fallen amber leaves on wet cobblestones, brownstone townhouses and a blurred café "
            "storefront in the background, overcast diffused daylight, soft cinematic color "
            "grading, realistic fabric folds and knit texture, visible skin detail, gentle "
            "motion blur in the background, shot on a modern smartphone with a 35mm equivalent "
            "lens, authentic street-style influencer content, unposed, photorealistic, highly "
            "detailed."
        ),
    },
    {
        "id": "p3",
        "label": "UGC 3 · Beach sundress",
        "text": (
            "Candid UGC-style travel photo of a beautiful young female influencer on a tropical "
            "beach at golden hour, wearing a flowing off-white linen sundress with a fitted "
            "bodice and thigh-high slit, wide-brim straw hat, layered shell necklaces, barefoot "
            "in the shallow surf, wind lifting the hem of her dress, sun-kissed skin with "
            "realistic texture, natural freckles, relaxed joyful expression. Turquoise ocean "
            "waves and soft white sea foam, distant palm trees, warm backlight creating a "
            "glowing rim around her hair, subtle lens flare, sand particles in the air, handheld "
            "smartphone camera angle, slight tilt, authentic vacation influencer content, "
            "photorealistic, highly detailed, 24mm wide-angle lifestyle photography."
        ),
    },
    {
        "id": "p4",
        "label": "UGC 4 · Neon night out",
        "text": (
            "Flash-photography UGC-style snapshot of a glamorous young female influencer outside "
            "a neon-lit cocktail bar at night, wearing a black satin slip dress with delicate "
            "straps and a cropped leather jacket, strappy heels, silver statement earrings, "
            "glossy dark hair, dewy night-out makeup with a bold lip. She turns toward the "
            "camera mid-laugh, holding a small metallic clutch, blurred friends and neon signage "
            "behind her, reflections on wet pavement, direct on-camera flash creating crisp "
            "highlights and a dark background, realistic skin texture and fabric sheen, slight "
            "motion blur at the edges, authentic influencer nightlife photo, unposed, "
            "photorealistic, highly detailed."
        ),
    },
    {
        "id": "p5",
        "label": "UGC 5 · 300-word farmers market",
        "text": (
            "Candid UGC-style smartphone photograph of a 25-year-old female lifestyle "
            "influencer at a bustling weekend farmers market in a coastal town, captured in a "
            "natural unposed moment as she turns back toward the camera with a warm smile. She "
            "is wearing a soft sage-green linen midi dress with a fitted bodice, square "
            "neckline, and a flowing A-line skirt that moves gently in the sea breeze, paired "
            "with tan leather sandals, a small raffia tote bag over one shoulder, delicate gold "
            "necklaces, and small pearl hoop earrings. Her light brown hair is pulled back in a "
            "loose claw clip with face-framing pieces, and her makeup is minimal: dewy skin, "
            "subtle peach blush, feathered brows, and a glossy nude lip. The scene around her is "
            "rich with detail: wooden market stalls overflowing with ripe peaches, heirloom "
            "tomatoes, bundles of lavender, fresh sourdough bread, and colorful summer flowers; "
            "hand-painted price signs; a chalkboard juice menu; woven baskets and crumpled paper "
            "bags; a vendor in a canvas apron blurred in the background; warm fairy lights "
            "between white awnings; damp cobblestones from an early-morning drizzle; seagulls "
            "and a sliver of blue harbor in the distance. Late-morning sunlight filters through "
            "the awnings, creating soft dappled light across her face and dress, gentle "
            "highlights in her hair, and natural shadows that reveal the texture of the linen "
            "fabric, the grain of the wooden stalls, and the moisture on the produce. The image "
            "is shot at eye level on a modern iPhone with a 26mm lens, shallow depth of field "
            "focused on her face and upper body, slight handheld imperfection, realistic skin "
            "pores and fine hair, clean and natural color grading with warm highlights and "
            "softly muted greens, very subtle film grain, and a truly authentic social-media "
            "influencer aesthetic. "
            "Photorealistic, highly detailed, editorial lifestyle photography, no text, no "
            "watermark."
        ),
    },
]

DEFAULT_NEGATIVE = (
    "low quality, worst quality, blurry, out of focus, overexposed, underexposed, noisy, "
    "grainy, jpeg artifacts, watermark, text, logo, signature, frame, border, cropped head, "
    "cropped feet, bad anatomy, deformed body, distorted proportions, extra limbs, missing "
    "limbs, extra fingers, fused fingers, malformed hands, long neck, bad face, asymmetrical "
    "eyes, crossed eyes, lazy eye, plastic skin, waxy skin, overly smooth skin, airbrushed, "
    "doll-like, cartoon, anime, illustration, painting, 3d render, cgi, duplicate subject, "
    "clone, multiple people, distorted background, warped architecture, blurry background, "
    "low resolution, pixelated, bad perspective, harsh flash artifacts, unnatural shadows, "
    "oversaturated, color banding"
)

# Positive and mirrored negative LoRA strengths. 0.50 and 0.80 were removed
# because they showed too little difference from their neighbours in testing.
STRENGTHS = [-2.0, -1.5, -1.0, -0.25, 0.25, 1.0, 1.5, 2.0]

RESOLUTION_PRESETS = [
    {"id": "flux2_portrait", "label": "Flux2 portrait · 832 × 1216", "width": 832, "height": 1216},
    {"id": "zimage_portrait", "label": "Z-Image portrait · 1024 × 1536", "width": 1024, "height": 1536},
    {"id": "krea2_portrait", "label": "Krea2 portrait · 1024 × 1536", "width": 1024, "height": 1536},
    {"id": "krea2_large", "label": "Krea2 large · 1344 × 1984", "width": 1344, "height": 1984},
    {"id": "moss_portrait", "label": "MOSS-Image portrait · 1024 × 1536 (1.5 MP)", "width": 1024, "height": 1536},
    {"id": "moss_square", "label": "MOSS-Image square · 1024 × 1024 (1 MP)", "width": 1024, "height": 1024},
    {"id": "h3image_portrait", "label": "H3 Image portrait · 1792 × 2304 (4 MP)", "width": 1792, "height": 2304},
    {"id": "h3image_large", "label": "H3 Image large · 3072 × 4096 (12.6 MP, slow)", "width": 3072, "height": 4096},
    {"id": "sdxl_portrait", "label": "SDXL portrait · 832 × 1216", "width": 832, "height": 1216},
    {"id": "sdxl_square", "label": "SDXL square · 1024 × 1024", "width": 1024, "height": 1024},
    {"id": "sd15_portrait", "label": "SD 1.5 portrait · 512 × 768", "width": 512, "height": 768},
    {"id": "sd15_square", "label": "SD 1.5 square · 512 × 512", "width": 512, "height": 512},
]
