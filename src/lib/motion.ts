import { motion, type MotionProps } from 'framer-motion';
import type React from 'react';

type MotionDivProps = MotionProps & React.HTMLAttributes<HTMLDivElement>;
type MotionH3Props = MotionProps & React.HTMLAttributes<HTMLHeadingElement>;
type MotionPProps = MotionProps & React.HTMLAttributes<HTMLParagraphElement>;
type MotionButtonProps = MotionProps & React.ButtonHTMLAttributes<HTMLButtonElement>;

const MotionDiv = motion.div as unknown as React.FC<MotionDivProps>;
const MotionH3 = motion.h3 as unknown as React.FC<MotionH3Props>;
const MotionP = motion.p as unknown as React.FC<MotionPProps>;
const MotionButton = motion.button as unknown as React.FC<MotionButtonProps>;

const smoothEase = [0.16, 1, 0.3, 1] as const;

const fastTransition = {
  duration: 0.16,
  ease: smoothEase,
};

const softTransition = {
  duration: 0.22,
  ease: smoothEase,
};

const panelTransition = {
  duration: 0.26,
  ease: smoothEase,
};

const pageTransition = {
  duration: 0.34,
  ease: smoothEase,
};

const springPanelTransition = {
  type: 'spring',
  stiffness: 380,
  damping: 34,
  mass: 0.8,
} as const;

const fadeUp = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 4 },
  transition: softTransition,
};

const gentleRise = {
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 8 },
  transition: pageTransition,
};

const subtleFade = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: fastTransition,
};

const scaleIn = {
  initial: { opacity: 0, scale: 0.98, y: 8 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.98, y: 6 },
  transition: panelTransition,
};

const listContainer = {
  animate: {
    transition: {
      staggerChildren: 0.035,
      delayChildren: 0.02,
    },
  },
};

const listItem = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 3 },
  transition: fastTransition,
};

export {
  smoothEase,
  fastTransition,
  softTransition,
  panelTransition,
  pageTransition,
  springPanelTransition,
  fadeUp,
  gentleRise,
  subtleFade,
  scaleIn,
  listContainer,
  listItem,
  MotionDiv,
  MotionH3,
  MotionP,
  MotionButton,
};
