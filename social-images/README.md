# Post images

Put real photos here. They are converted automatically to the 1080x1350 JPEG that Instagram needs.

| File name | Used for |
|---|---|
| `doctor-<slug>.jpg` (or .png/.webp) | Doctor spotlight, e.g. `doctor-nirmal-patil.jpg` |
| `department-<slug>.jpg` | Department post, e.g. `department-cardiology.jpg` |
| `hospital-<topic-key>.jpg` | Hospital-wide post, e.g. `hospital-emergency.jpg` |
| `hospital.jpg` | Fallback for any hospital-wide or ad-hoc post |

The slugs come from `data/hospital.json`. If no photo exists, the tool generates a simple branded
text card instead, so posting never fails for lack of an image. Real photos look much better.
